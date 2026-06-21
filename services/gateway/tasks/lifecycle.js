/**
 * Task folder lifecycle — rename on approve, rename back on reject/reopen,
 * and the full "sync the DB row to disk" render. Every write passes
 * through swallow() so a permissions error or missing workspace NEVER
 * blocks a DB state transition; callers receive a best-effort `{queued,
 * warning}` shape so they can report status to the UI.
 *
 * Lifted from legacy lib/task-files.js. Replaces the inline
 * `renameOnApprove`, `renameOnRejectOrReopen`, `syncTaskFileLifecycle`
 * trio with one module the state-machine consumes via `./lifecycle.js`.
 */
import path from 'node:path';
import fs from 'node:fs';
import { swallow } from '@cortex/sdk/errors';
import {
  getProjectDir,
  getPhaseDir,
  findTaskFolderByUuid,
  humanTaskFolderName,
  countTaskFoldersInPhase,
} from './folders.js';
import { renderTaskReadme, writeText } from './readme.js';
import { getTaskStatements } from './statements.js';

const README_NAME = 'README.md';
const FINISHED_SUFFIX = ' (finished)';
const DELETED_SUFFIX = ' (deleted)';

function safeRename(from, to) {
  if (from === to) return { renamed: false, reason: 'noop' };
  try {
    fs.renameSync(from, to);
    return { renamed: true, from, to };
  } catch (err) {
    swallow('tasks.folder_rename_failed', err);
    return { renamed: false, reason: err.message || 'rename_failed' };
  }
}

/**
 * Mark the folder as finished by appending " (finished)". Idempotent —
 * if the folder is already suffixed, this is a no-op. Also idempotent if
 * the source folder doesn't exist (returns `{renamed:false, reason:'missing'}`).
 */
export function renameOnApprove({ taskId }) {
  const stmts = getTaskStatements();
  const task = stmts.getTask.get(taskId);
  if (!task) return { renamed: false, reason: 'task_not_found' };
  const project = task.project_id ? stmts.getProject.get(task.project_id) : null;
  const phaseNumber = inferPhaseNumber(task);
  const phaseDir = getPhaseDir(project, phaseNumber);
  if (!phaseDir) return { renamed: false, reason: 'phase_dir_unknown' };
  const currentDir = findTaskFolderByUuid(phaseDir, taskId);
  if (!currentDir) return { renamed: false, reason: 'missing' };
  if (currentDir.endsWith(FINISHED_SUFFIX)) {
    return { renamed: false, reason: 'already_finished' };
  }
  const target = `${currentDir}${FINISHED_SUFFIX}`;
  return safeRename(currentDir, target);
}

/**
 * Mark the folder as deleted by appending " (deleted)". Convention:
 * never rm -rf — rename only so the folder survives until manual cleanup.
 * Idempotent; if already suffixed, returns `{renamed:false, reason:'already_deleted'}`.
 * Added Phase 3.0.b to unblock transitions.js barrel load.
 */
export function renameOnDelete({ taskId }) {
  const stmts = getTaskStatements();
  const task = stmts.getTask.get(taskId);
  if (!task) return { renamed: false, reason: 'task_not_found' };
  const project = task.project_id ? stmts.getProject.get(task.project_id) : null;
  const phaseNumber = inferPhaseNumber(task);
  const phaseDir = getPhaseDir(project, phaseNumber);
  if (!phaseDir) return { renamed: false, reason: 'phase_dir_unknown' };
  const currentDir = findTaskFolderByUuid(phaseDir, taskId);
  if (!currentDir) return { renamed: false, reason: 'missing' };
  if (currentDir.endsWith(DELETED_SUFFIX)) {
    return { renamed: false, reason: 'already_deleted' };
  }
  const target = `${currentDir}${DELETED_SUFFIX}`;
  return safeRename(currentDir, target);
}

/**
 * Strip " (finished)" if it's there. Used on reject + reopen so the
 * folder name reflects the "still in flight" state. Idempotent.
 */
export function renameOnRejectOrReopen({ taskId }) {
  const stmts = getTaskStatements();
  const task = stmts.getTask.get(taskId);
  if (!task) return { renamed: false, reason: 'task_not_found' };
  const project = task.project_id ? stmts.getProject.get(task.project_id) : null;
  const phaseNumber = inferPhaseNumber(task);
  const phaseDir = getPhaseDir(project, phaseNumber);
  if (!phaseDir) return { renamed: false, reason: 'phase_dir_unknown' };
  const currentDir = findTaskFolderByUuid(phaseDir, taskId);
  if (!currentDir) return { renamed: false, reason: 'missing' };
  if (!currentDir.endsWith(FINISHED_SUFFIX)) {
    return { renamed: false, reason: 'already_unfinished' };
  }
  const target = currentDir.slice(0, -FINISHED_SUFFIX.length);
  return safeRename(currentDir, target);
}

/**
 * The "sync everything to disk" entry point called after every state
 * transition. Creates the task folder if it doesn't exist, regenerates
 * README.md from the latest DB row + journal, and returns a compact
 * object describing what happened (UI consumes this as `file_sync`).
 *
 * NEVER throws. A misconfigured workspace root returns
 * `{queued: true, warning: '...'}` so the caller's 200 stays a 200.
 */
export function syncTaskFileLifecycle({ taskId }) {
  try {
    const stmts = getTaskStatements();
    const task = stmts.getTask.get(taskId);
    if (!task) return { queued: false, warning: 'task_not_found' };
    const project = task.project_id ? stmts.getProject.get(task.project_id) : null;
    const phaseNumber = inferPhaseNumber(task);
    const phaseDir = getPhaseDir(project, phaseNumber);
    if (!phaseDir) return { queued: true, warning: 'phase_dir_unknown' };

    fs.mkdirSync(phaseDir, { recursive: true });

    let taskDir = findTaskFolderByUuid(phaseDir, taskId);
    if (!taskDir) {
      const index = countTaskFoldersInPhase(phaseDir) + 1;
      const human = humanTaskFolderName(index, task.title);
      taskDir = path.join(phaseDir, human);
      try { fs.mkdirSync(taskDir, { recursive: true }); }
      catch (err) { swallow('tasks.mkdir_task_dir_failed', err);
        return { queued: true, warning: err.message }; }
    }

    const journal = stmts.journalByTaskAsc.all(taskId);
    const progress = stmts.progressByTaskAsc.all(taskId);
    const readmeBody = renderTaskReadme(task, {
      project_name: project?.name || null,
      journal: journal.map((row) => ({
        created_at: row.created_at,
        entry_type: row.entry_type,
        summary: row.summary,
        author: row.author,
      })),
      progress: progress.map((row) => ({
        timestamp: row.created_at,
        status: row.stage,
        summary: row.message,
        files_changed: safeJsonArray(row.metadata, 'files_changed'),
      })),
    });
    try {
      writeText(path.join(taskDir, README_NAME), readmeBody);
      return { queued: false, task_dir: taskDir };
    } catch (err) {
      swallow('tasks.readme_write_failed', err);
      return { queued: true, warning: err.message };
    }
  } catch (err) {
    // Outer catch — something unexpected (stat, readdir etc.) broke.
    // Still a best-effort path; return the warning and let the caller
    // surface it in its 200 response.
    swallow('tasks.sync_lifecycle_failed', err);
    return { queued: true, warning: err.message };
  }
}

// -- helpers ---------------------------------------------------------------

/**
 * The `tasks` table in 001_initial_schema.sql tracks phase via a FK
 * (`phase_id` → phases.id). Folder naming needs the numeric ordinal, so
 * we resolve phases.ordinal when present; fall back to 1 otherwise.
 */
export function inferPhaseNumber(task) {
  if (!task) return 1;
  if (task.phase_number) return task.phase_number;
  if (!task.phase_id) return 1;
  const stmts = getTaskStatements();
  try {
    const row = stmts.listPhases.all(task.project_id)
      .find((p) => p.id === task.phase_id);
    if (!row) return 1;
    // phases.ordinal is 0-indexed (matches the insertion count at
    // addPhase time); folder paths are 1-indexed ("phase-1"). Shift.
    return (Number(row.ordinal) || 0) + 1;
  } catch (err) {
    void err; return 1;
  }
}

function safeJsonArray(raw, key) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const v = parsed?.[key];
    return Array.isArray(v) ? v : [];
  } catch (err) {
    void err; return [];
  }
}
