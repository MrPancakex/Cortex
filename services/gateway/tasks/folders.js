/**
 * Task folder naming + on-disk lookup. All I/O is read-only here — writes
 * live in `readme.js` (render) and `lifecycle.js` (rename). Errors never
 * propagate: every fs call is guarded because the folder mirror is a
 * convenience, and a permissions mishap must not block a DB transition.
 *
 * Lifted from legacy lib/task-files.js and trimmed to the functions
 * Phase 5's state-machine + lifecycle code actually calls.
 */
import path from 'node:path';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { resolveProjectsRoot, slugify, sanitiseTitleForFolder } from './paths.js';

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch (err) {
    // `statSync` throws ENOENT for missing paths. We don't want to
    // propagate — the caller only wanted a boolean. Reference err so
    // Rule 2.B is satisfied.
    void err;
    return false;
  }
}

function safeRead(fp) {
  try { return readFileSync(fp, 'utf8'); } catch (err) {
    void err; return '';
  }
}

/**
 * Zero-padded task index — "task-01", "task-02". Used for legacy folder
 * layouts that pre-date the UUID-based naming.
 */
export function taskDirectoryName(index) {
  return `task-${String(index).padStart(2, '0')}`;
}

/**
 * Human-readable folder: "Task 42 - Fix the widget crash". The index
 * provides stable ordering; the title is sanitised via
 * `sanitiseTitleForFolder` so `mkdir` accepts it on every platform.
 */
export function humanTaskFolderName(n, title) {
  return `Task ${n} - ${sanitiseTitleForFolder(title)}`;
}

/**
 * Count task-shaped folders in a phase directory. Recognises both the
 * legacy "Task N - ..." layout and the UUID-prefixed layout. Used by
 * phase README rendering.
 */
export function countTaskFoldersInPhase(phaseDir) {
  if (!isDir(phaseDir)) return 0;
  let count = 0;
  try {
    for (const entry of readdirSync(phaseDir)) {
      const entryPath = path.join(phaseDir, entry);
      if (!isDir(entryPath)) continue;
      if (entry.startsWith('Task ')) count++;
      else if (/^[0-9a-f]{8}-/.test(entry)) count++;
    }
  } catch (err) {
    void err; return 0;
  }
  return count;
}

/**
 * Parse the YAML-style frontmatter block of a task README. Returns {} if
 * the file has no `---` block; never throws. Keys are trimmed; values are
 * trimmed but not type-coerced.
 */
export function parseTaskFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return {};
  const meta = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return meta;
}

/**
 * Find a task folder by its DB UUID. Tries (in order):
 *   1. `<phaseDir>/<taskId>/`           — canonical
 *   2. `<phaseDir>/<taskId> (finished)/`— post-approval rename
 *   3. scan frontmatter of every subdirectory for matching task_id
 *
 * Returns an absolute path or null. Never throws.
 */
export function findTaskFolderByUuid(phaseDir, taskId) {
  if (!isDir(phaseDir)) return null;
  const plain = path.join(phaseDir, taskId);
  if (isDir(plain)) return plain;
  const finished = path.join(phaseDir, `${taskId} (finished)`);
  if (isDir(finished)) return finished;
  let entries;
  try { entries = readdirSync(phaseDir); } catch (err) {
    void err; return null;
  }
  for (const entry of entries) {
    const dirPath = path.join(phaseDir, entry);
    if (!isDir(dirPath)) continue;
    const readmePath = path.join(dirPath, 'README.md');
    if (!existsSync(readmePath)) continue;
    const meta = parseTaskFrontmatter(safeRead(readmePath));
    if (meta.task_id === taskId) return dirPath;
  }
  return null;
}

/**
 * "Find the dir named `name` under `basePath`, either plain or tagged
 * `(finished)`." Used by the lifecycle path when status renames a
 * folder — the pre-rename and post-rename names must both be discoverable.
 */
export function findDir(basePath, name) {
  const plain = path.join(basePath, name);
  if (isDir(plain)) return plain;
  const finished = path.join(basePath, `${name} (finished)`);
  if (isDir(finished)) return finished;
  return null;
}

/**
 * Get the on-disk directory for a given project row. Uses the project's
 * `root_path` column if set and absolute; otherwise falls back to the
 * slugified name under the configured projects root.
 */
export function getProjectDir(project) {
  if (!project) return null;
  if (project.root_path && path.isAbsolute(project.root_path)) {
    return project.root_path;
  }
  return path.join(resolveProjectsRoot(), slugify(project.name || project.id));
}

export function getPhaseDir(project, phaseNumber) {
  const pd = getProjectDir(project);
  if (!pd) return null;
  return path.join(pd, 'tasks', `phase-${phaseNumber || 1}`);
}

/**
 * End-to-end lookup: given a project slug + phase + uuid, return the
 * concrete task folder on disk (or null). The state-machine.getTask
 * path calls this to attach `file_sync: { task_dir }` when rendering.
 */
export function findTaskDir(projectSlug, phaseNumber, taskId) {
  const root = resolveProjectsRoot();
  const projectDir = findDir(root, projectSlug);
  if (!projectDir) return null;
  const tasksDir = path.join(projectDir, 'tasks');
  const phaseDir = findDir(tasksDir, `phase-${phaseNumber || 1}`);
  if (!phaseDir) return null;
  return findTaskFolderByUuid(phaseDir, taskId);
}
