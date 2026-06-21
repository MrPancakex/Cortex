/**
 * Task state-machine shared internals — extracted from state-machine.js
 * (Phase 3.0.b) so the read (queries.js) and write (transitions.js)
 * halves can share one copy of the response helpers, identity checks,
 * and small lookups without a 1k-line god-file.
 *
 * Pure extraction: every export here is relocated verbatim from the
 * pre-split state-machine.js as it stood in the working tree — the 10
 * helpers + identity checks AND the `ok`/`created`/`badRequest`/…
 * response builders, including the `{ __schema_version }` envelope that
 * `ok`/`created` already spread there. Phase 3.0 moves this code; it does
 * not author the envelope (provenance of `API_SCHEMA_VERSION` itself is
 * the contract-layer changeset, not git HEAD and not this phase). No
 * behavior change — state-machine.js is now a barrel re-exporting
 * queries.js + transitions.js.
 */
import path from 'node:path';
import fs from 'node:fs';
import { API_SCHEMA_VERSION } from '@cortex/core/constants';
import { swallow } from '@cortex/sdk/errors';
import { sameBaseAgent } from '@cortex/sdk/auth';
import { getDb } from '@cortex/sdk/db';
import { normSqliteTs } from '@cortex/sdk/http';
import { getTaskStatements } from './statements.js';
import { inferPhaseNumber, syncTaskFileLifecycle } from './lifecycle.js';
import {
  getProjectDir,
  findTaskFolderByUuid,
  getPhaseDir,
  humanTaskFolderName,
  countTaskFoldersInPhase,
} from './folders.js';
import { writeTaskJson } from './ledger.js';
import { dbRowToTaskJson, taskJsonToDbColumns, applyFoldOverlay } from './task-projection.js';
import { parseTaskJson, findTaskJsonFiles, auditRowFromEvent, normTsForAudit, resolveOrCreatePhaseId } from './reconciler.js';
import { foldTask, readEventsJsonl } from './fold-engine.js';

// -- per-task events.jsonl target resolution (Task 120, D4) -----------------
//
// Phase 1b resolved the task folder read-only and SILENTLY SKIPPED the
// per-task events.jsonl append when the folder was not on disk yet. Task 120
// (D4 — no silent skips) replaces that with an explicit create-or-fail-loud
// policy: when the canonical task folder is absent at append time, it is
// CREATED (same naming scheme syncTaskFileLifecycle uses) so the event line
// always has its canonical home; any mkdir/write failure THROWS so the
// surrounding SQLite transaction rolls back (fail-loud, never skip).
//
// The folder creation happens OUTSIDE the SQLite transaction (fs is not
// transactional) — callers compensate with removeCreatedTaskDir() when the
// transaction subsequently fails, so a failed transition leaves zero residue.

/** 1-based phase ordinal for a task row (shared with resolvePhaseNumber). */
export function resolveTaskPhaseDir(project, taskRow) {
  const phaseNumber = inferPhaseNumber(taskRow);
  return getPhaseDir(project, phaseNumber);
}

/**
 * Resolve the task's on-disk folder, creating it when absent.
 *
 * R1 (finding 6): the resolver may also create the PHASE tree
 * (`mkdirSync(phaseDir, {recursive:true})` can create phase-N and any missing
 * ancestors, e.g. tasks/). `createdDirs` records exactly which ancestor
 * directories did NOT exist before this call (shallowest first) so the
 * compensation path can remove precisely what was created — and never a
 * pre-existing directory.
 *
 * @param {object} project — projects row (root_path resolution)
 * @param {object} taskRow — tasks row (or createTask's pre-insert stub)
 * @returns {{ taskDir: string, created: boolean, createdDirs: string[] }}
 * @throws {Error} 'phase_dir_unknown' when no phase dir can be resolved;
 *         any fs error from mkdir / the placeholder README write.
 */
export function resolveOrCreateTaskDir(project, taskRow) {
  const phaseDir = resolveTaskPhaseDir(project, taskRow);
  if (!phaseDir) throw new Error('phase_dir_unknown');
  const existing = findTaskFolderByUuid(phaseDir, taskRow.id);
  if (existing) return { taskDir: existing, created: false, createdDirs: [] };
  // R1: record the not-yet-existing ancestors BEFORE mkdir creates them.
  const createdDirs = [];
  for (let probe = phaseDir; !fs.existsSync(probe); probe = path.dirname(probe)) {
    createdDirs.unshift(probe);
    if (path.dirname(probe) === probe) break; // fs root — stop
  }
  // D4: missing events target → CREATE (never skip). Any failure throws.
  //
  // R3 (R2 #1): the phase-tree mkdir, the task-dir mkdir AND the README
  // placeholder write all live under ONE cleanup scope. Pre-R3 the two mkdirs
  // ran before the try — a task-dir mkdir failure AFTER the phase ancestors
  // were created (e.g. a regular FILE colliding at the taskDir path → EEXIST)
  // left the created ancestors behind with no resolved object for callers to
  // compensate. Now ANY failure during resolution removes exactly what this
  // call created: the task dir only when its mkdir actually created it
  // (mkdirSync returns undefined for a pre-existing dir — never remove those,
  // and never remove a colliding FILE), then the recorded phase ancestors
  // deepest-first, empty-checked (removeCreatedParentDirs).
  let taskDir = null;
  let taskDirCreated = false;
  try {
    fs.mkdirSync(phaseDir, { recursive: true });
    const index = countTaskFoldersInPhase(phaseDir) + 1;
    taskDir = path.join(phaseDir, humanTaskFolderName(index, taskRow.title));
    taskDirCreated = fs.mkdirSync(taskDir, { recursive: true }) !== undefined;
    // Minimal frontmatter README so findTaskFolderByUuid (which falls back to
    // a frontmatter scan for human-named folders) can re-discover this folder
    // before the first full syncFiles render overwrites it post-commit.
    //
    // R4 (R3 #5): only write the README when THIS call actually CREATED
    // the directory. A pre-existing directory at the computed path is NEVER
    // overwritten — its existing README (and all other contents) are left
    // intact. (mkdirSync with recursive:true returns undefined for a dir that
    // already existed, so taskDirCreated:false → skip the write.)
    if (taskDirCreated) {
      const title = String(taskRow.title ?? '').replace(/[\r\n]/g, ' ');
      fs.writeFileSync(
        path.join(taskDir, 'README.md'),
        `---\ntask_id: ${taskRow.id}\ntitle: ${title}\nstatus: ${taskRow.status ?? 'pending'}\n---\n`,
        'utf8',
      );
    }
  } catch (err) {
    // Anything this resolution created is residue — remove it before
    // rethrowing so the failed resolution leaves nothing behind. A
    // pre-existing entry (incl. a colliding FILE at the taskDir path) is
    // never removed.
    if (taskDirCreated) {
      try { fs.rmSync(taskDir, { recursive: true, force: true }); }
      catch (cleanupErr) { swallow('tasks.task_dir_cleanup_failed', cleanupErr); }
    }
    removeCreatedParentDirs(createdDirs);
    throw err;
  }
  return { taskDir, created: taskDirCreated, createdDirs };
}

/**
 * R1 (finding 6): remove the parent directories a failed transition's
 * resolveOrCreateTaskDir call CREATED, deepest first. Each dir is removed
 * only when it is empty (rmdirSync also refuses non-empty as a backstop) —
 * a directory that gained unrelated entries since creation is left alone,
 * and a pre-existing directory is never in `createdDirs` to begin with.
 * Best-effort, never throws (error-path code; the original error wins).
 */
export function removeCreatedParentDirs(createdDirs) {
  if (!Array.isArray(createdDirs)) return;
  for (let i = createdDirs.length - 1; i >= 0; i--) {
    const dir = createdDirs[i];
    try {
      if (!fs.existsSync(dir)) continue;
      if (fs.readdirSync(dir).length > 0) break; // non-empty → ancestors are too
      fs.rmdirSync(dir);
    } catch (err) {
      swallow('tasks.created_parent_dir_remove_failed', err);
      break;
    }
  }
}

/**
 * Compensation for resolveOrCreateTaskDir: when the surrounding transaction
 * fails AFTER the folder was created for this transition, remove it — and
 * (R1) any phase ancestors created by the same call — so the failed
 * transition leaves zero filesystem residue. Best-effort (never throws) —
 * it runs on the error path where the original error must win.
 */
export function removeCreatedTaskDir(resolved) {
  if (!resolved) return;
  if (resolved.created) {
    try { fs.rmSync(resolved.taskDir, { recursive: true, force: true }); }
    catch (err) { swallow('tasks.created_task_dir_remove_failed', err); }
  }
  removeCreatedParentDirs(resolved.createdDirs);
}

// -- response helpers ------------------------------------------------------

export const ok = (body) => ({ status: 200, body: { ...body, __schema_version: API_SCHEMA_VERSION } });
export const created = (body) => ({ status: 201, body: { ...body, __schema_version: API_SCHEMA_VERSION } });
export const badRequest = (error, extras = {}) => ({ status: 400, body: { error, ...extras } });
export const unauthorized = () => ({ status: 401, body: { error: 'missing or invalid token' } });
export const forbidden = (reason) => ({ status: 403, body: { error: 'forbidden', reason } });
export const notFound = () => ({ status: 404, body: { error: 'not_found' } });
export const conflict = (error, extras = {}) => ({ status: 409, body: { error, ...extras } });

// -- helpers --------------------------------------------------------------

export function hint(next) { return { next_step_hint: next }; }

export function sanitiseSummary(value, maxLen = 5000, { multiline = true } = {}) {
  if (value == null || typeof value !== 'string') return null;
  // Strip ANSI CSI + HTML-like tags + low control chars. Multiline keeps
  // newlines when allowed; otherwise collapse to single line.
  const ANSI_CSI = new RegExp('\\u001b\\[[0-9;]*[a-zA-Z]', 'g');
  let out = value.replace(ANSI_CSI, '').replace(/<[^>]*>/g, '');
  if (!multiline) out = out.replace(/[\r\n]/g, ' ');
  return out.trim().slice(0, maxLen);
}

// Identity comparator used for every owner / creator / reviewer check.
// Routes through the shared registry-backed `sameBaseAgent` so hyphenated
// base ids (e.g. `my-agent` vs `my-other-agent`) never collide — a naive
// `split('-')[0]` or `startsWith(base + '-')` check would wrongly merge
// them. Wrapped in a local const so tests can still read the reference
// and so the injection sites into access.js stay explicit.
export const sameAgent = sameBaseAgent;

// -- D2: reconcile-on-miss helper -------------------------------------------

// _normTsSecond → collapsed to normSqliteTs from sdk/http/iso.js (S1 consolidation).
// Alias kept only to satisfy the existing call sites below; callers should migrate
// to normSqliteTs directly on their next pass.
const _normTsSecond = normSqliteTs;

/**
 * ROOT B (F2): Search all known project directories for a task folder by UUID.
 * Uses FOLDER-FIRST semantics: for each project, for each phase-N directory,
 * call findTaskFolderByUuid (UUID-named dir, "(finished)" suffix, frontmatter
 * scan) to locate the folder — THEN parse task.json inside the found folder.
 *
 * This is the correct order per the Phase 3 contract:
 *   - locate folder by UUID → parse task.json inside
 *   NOT: iterate task.json files → check their id field
 *
 * The distinction matters when task.json is MISSING or CORRUPT: the old approach
 * silently skips parse failures and returns null (triggering a 404). The new
 * approach returns { found: true, rebuildable: false } so the caller can surface
 * a 409 task_unrebuildable (folder exists, cannot be rebuilt — NOT absent).
 *
 * Returns one of:
 *   { found: false }                         — no folder in any phase dir of any project
 *   { found: true, taskDir, taskJson,        — folder found AND task.json parsed
 *     phaseNumber, project }
 *   { found: true, rebuildable: false,       — folder found but task.json missing/corrupt
 *     error, taskDir, phaseNumber, project }
 *
 * @param {string} taskId
 */
function findTaskInProjectDirs(taskId) {
  const stmts = getTaskStatements();
  const allProjects = stmts.listProjects.all();
  for (const project of allProjects) {
    const projectDir = getProjectDir(project);
    if (!projectDir) continue;
    try {
      if (!fs.existsSync(projectDir)) continue;
    } catch (_) { continue; }

    // Scan all phase-N directories under this project
    const tasksRoot = path.join(projectDir, 'tasks');
    let phaseEntries;
    try {
      phaseEntries = fs.readdirSync(tasksRoot);
    } catch (_) {
      phaseEntries = [];
    }

    for (const phaseEntry of phaseEntries) {
      const phaseMatch = phaseEntry.match(/^phase-(\d+)$/);
      if (!phaseMatch) continue;
      const phaseNumber = parseInt(phaseMatch[1], 10);
      const phaseDir = path.join(tasksRoot, phaseEntry);

      // ROOT B: FOLDER FIRST — locate by UUID before parsing task.json
      const taskDir = findTaskFolderByUuid(phaseDir, taskId);
      if (!taskDir) continue; // not in this phase dir

      // Folder found. Now parse task.json inside it.
      const taskJsonPath = path.join(taskDir, 'task.json');
      if (!fs.existsSync(taskJsonPath)) {
        // ROOT B: folder found but task.json missing → unrebuildable, NOT absent
        return {
          found: true,
          rebuildable: false,
          error: 'task_json_missing',
          taskDir,
          phaseNumber,
          project,
        };
      }

      const taskJson = parseTaskJson(taskJsonPath);
      if (!taskJson) {
        // ROOT B: folder found but task.json unparsable → unrebuildable, NOT absent
        return {
          found: true,
          rebuildable: false,
          error: 'task_json_unparsable',
          taskDir,
          phaseNumber,
          project,
        };
      }

      // ROOT 4 (R7): id-mismatch zero-residue check.
      // The folder was located by UUID/frontmatter matching taskId, but task.json
      // may carry a DIFFERENT id (e.g. stale file, copy-paste error). Upserting
      // the wrong id would contaminate the DB with residue for the wrong task while
      // the requested task is still missing. Surface immediately as unrebuildable
      // with diagnostics — BEFORE any fold or transaction — so ZERO rows are written.
      if (taskJson.id && taskJson.id !== taskId) {
        return {
          found: true,
          rebuildable: false,
          error: 'task_id_mismatch',
          diagnostics: { code: 'task_id_mismatch', folder_id: taskJson.id, requested_id: taskId },
          taskDir,
          phaseNumber,
          project,
        };
      }

      return { found: true, taskDir, taskJson, phaseNumber, project };
    }
  }
  return { found: false };
}

/**
 * D2 — Reconcile-on-miss: when requireTask finds no DB row, attempt to
 * rebuild from fs (folder → fold → upsert) and return the upserted row.
 *
 * CLUSTER B (F3/F6): Returns a discriminated result:
 *   { found: false }                            — no folder on disk → 404
 *   { found: true, task }                       — rebuilt successfully
 *   { found: true, rebuildable: false, error }  — folder found but fold/upsert
 *                                                 failed → 409/5xx (NOT 404)
 *
 * @param {string} taskId
 * @returns {{ found: boolean, task?: object, rebuildable?: boolean, error?: string }}
 */
function reconcileTaskFromFs(taskId) {
  const lookup = findTaskInProjectDirs(taskId);

  // ROOT B: propagate folder-found-but-unrebuildable directly (409, not 404)
  if (!lookup.found) return { found: false };
  if (lookup.rebuildable === false) {
    // Folder was found but task.json is missing, unparsable, or id-mismatched —
    // surface as unrebuildable immediately, no further processing possible.
    // ROOT 4 (R7): forward diagnostics (e.g. task_id_mismatch) so requireTask
    // can include them in the 409 response body without losing detail.
    return {
      found: true,
      rebuildable: false,
      error: lookup.error ?? 'task_json_unreadable',
      ...(lookup.diagnostics ? { diagnostics: lookup.diagnostics } : {}),
    };
  }

  const { taskDir, taskJson, phaseNumber, project } = lookup;
  const stmts = getTaskStatements();

  // Fold the events.jsonl to get lifecycle columns
  let folded;
  let events;
  try {
    events = readEventsJsonl(taskDir, taskId);
    folded = foldTask(events, taskJson);
  } catch (err) {
    // Folder found but unreadable/unfoldable → distinct error, NOT null
    swallow('tasks.reconcile_on_miss_fold_failed', err);
    return { found: true, rebuildable: false, error: `fold_failed: ${err.message}` };
  }

  if (folded.deleted) {
    // Folder found but task is logically deleted — surface as unrebuildable
    return { found: true, rebuildable: false, error: 'task_logically_deleted' };
  }

  // ROOT 3 (R7): Phase resolution precheck — read-only lookup outside the transaction.
  // resolveOrCreatePhaseId called here with dryRun=true (NO create). If the phase
  // already exists we get its id immediately; if not, existingPhaseId is null and
  // we create the phase INSIDE the recovery transaction below (all-or-nothing).
  //
  // This avoids the pre-R7 pattern where the CREATE happened BEFORE the transaction:
  // if the later task/audit upsert failed, the transaction rolled back but the phase
  // row was already committed — leaving partial phase-plane residue and making retries
  // observe a different DB state than the original failure.
  //
  // A throw from the read-only lookup (e.g. DB error) is caught below and surfaces
  // as task_unrebuildable — NOT as a {found:false} 404 (the folder was found).
  let existingPhaseId;
  try {
    existingPhaseId = resolveOrCreatePhaseId(project.id, phaseNumber, true /* dryRun=read-only */);
  } catch (err) {
    // Phase lookup itself failed (DB error) — folder found but unrebuildable.
    // Surface as 409 task_unrebuildable, NOT as a 404 (folder exists).
    swallow('tasks.reconcile_on_miss_phase_lookup_failed', err);
    return {
      found: true,
      rebuildable: false,
      error: `phase_lookup_failed: ${err.message}`,
      diagnostics: { code: 'phase_lookup_failed', project: project.id, phase: phaseNumber },
    };
  }

  const db = getDb();

  // Compute columns outside the transaction (no DB writes).
  // phase_id is resolved/created atomically inside the transaction below.
  // We pass a placeholder here and update cols.phase_id inside the txn.
  const cols = taskJsonToDbColumns(taskJson, project.id, existingPhaseId ?? null);

  // Override lifecycle columns with fold-derived values.
  // ROOT D (F6/F8): timestamps sourced from task.json (exact DB-origin SQLite space-form),
  // NOT from event.ts conversions (see bootRebuild ROOT D comment for full rationale).
  // _normTsSecond normalises any residual T-form; task.json is already space-form.
  cols.status          = folded.row.status ?? cols.status;
  cols.assigned_to     = folded.row.assigned_to ?? null;
  cols.claimed_at      = _normTsSecond(taskJson.claimed_at ?? folded.row.claimed_at) ?? null;
  cols.submitted_at    = _normTsSecond(taskJson.submitted_at ?? folded.row.submitted_at) ?? null;
  cols.approved_at     = _normTsSecond(taskJson.approved_at ?? folded.row.approved_at) ?? null;
  cols.rejection_count = folded.row.rejection_count ?? 0;
  cols.created_at      = _normTsSecond(taskJson.created_at ?? folded.row.created_at) ?? cols.created_at;
  cols.created_by      = folded.row.created_by ?? cols.created_by;
  // updated_at: task.json is authoritative (see ROOT D rationale in bootRebuild).
  cols.updated_at      = _normTsSecond(taskJson.updated_at) ?? _normTsSecond(folded.row.updated_at) ?? cols.updated_at;

  // metadata: taskJsonToDbColumns already restored the full metadata blob
  // (via metadata_blob) when task.json was written by dbRowToTaskJson. Apply
  // fold-derived null-authoritative values via applyFoldOverlay — authoritative
  // INCLUDING NULL (R5: reviewer_agent + section both covered):
  //   reviewer_agent: fold cleared it on reopen/release/reassign → json_remove parity
  //   section: three-state per R6 F1 — derive from taskJson key PRESENCE, not fold
  //     (fold collapses absent→null; that would incorrectly clear a blob section
  //      that taskJsonToDbColumns already left untouched for old task.json compat).
  //   'section' in taskJson → key present: pass value or null (authoritative clear)
  //   'section' NOT in taskJson → pass undefined (leave blob untouched, backward compat)
  // ROOT D: do NOT discard cols.metadata — preserves DB-resident sub-fields
  // (source, phase_number, review_feedback) that are set by SQL json_set() calls.
  // F4: clear delete_requested_* when the event trail ends with task_delete_denied
  //   (denyTaskDelete clears these in live DB; stale blob must not resurrect them).
  const sectionOverride = 'section' in taskJson ? taskJson.section : undefined;
  let deleteReqOverride = {};
  {
    let lastDeniedIdx  = -1;
    let lastRequestIdx = -1;
    for (let ei = 0; ei < events.length; ei++) {
      const evt = events[ei];
      if (evt.event_type === 'task_delete_denied')    lastDeniedIdx  = ei;
      if (evt.event_type === 'task_delete_requested') lastRequestIdx = ei;
    }
    if (lastDeniedIdx >= 0 && lastDeniedIdx > lastRequestIdx) {
      deleteReqOverride = { delete_requested_at: null, delete_requested_by: null };
    }
  }
  cols.metadata = applyFoldOverlay(cols.metadata, {
    reviewer_agent:       folded.row.reviewer_agent ?? null,
    section:              sectionOverride,
    ...deleteReqOverride,
  });

  try {
    // ROOT 3 (R7): Upsert task row, synthesize audit_log rows, AND (when needed)
    // CREATE the missing phase row — all in one atomic transaction. This ensures
    // all-or-nothing recovery: if any upsert fails the entire transaction rolls back,
    // leaving ZERO phase/task/audit residue. The phase CREATE is inside the same
    // transaction so a subsequent failure cannot leave a committed phase row behind.
    //
    // Task 143 NOTE: audit created_at uses ev.ts (durable events.jsonl source).
    // Live insertAudit uses datetime('now'); a ≤1s second-boundary difference is
    // possible when the live insert and the event ts cross a second boundary.
    // Carved to Task 143 (live-writer coupling is OUT OF FENCE). Tests use
    // equal-second fixtures to avoid false failures.
    db.transaction(() => {
      // ---- 3a. Create missing phase (if not already existing) ----------------
      // ROOT 3 (R7): phase CREATE is inside the transaction so a later task/audit
      // failure rolls back the phase creation too — no partial phase residue.
      let phaseId = existingPhaseId;
      if (!phaseId) {
        // Phase did not exist before this transaction — create it now.
        phaseId = resolveOrCreatePhaseId(project.id, phaseNumber, false);
        if (!phaseId) throw new Error('phase_create_failed: resolveOrCreatePhaseId returned null');
        // Update cols to use the newly created phase id
        cols.phase_id = phaseId;
      }

      // ---- 3b. Upsert task row -------------------------------------------
      stmts.upsertTaskFromFs.run(
        cols.id,
        cols.project_id,
        cols.phase_id,
        cols.title,
        cols.description,
        cols.status,
        cols.priority,
        cols.assigned_to,
        cols.created_by,
        cols.tags,
        cols.metadata,
        cols.result,
        cols.rejection_count,
        cols.parent_task_id,
        cols.lease_token,
        cols.lease_expires_at,
        cols.created_at,
        cols.updated_at,
        cols.claimed_at,
        cols.submitted_at,
        cols.approved_at,
        cols.deadline,
        taskDir,                    // folder_path
        taskJson.fs_version ?? 0,   // fs_version from file
      );
      // ---- 3c. Synthesize audit_log rows from events.jsonl ------------------
      // Sharing bootRebuild's path (auditRowFromEvent + normTsForAudit).
      // Idempotent: DELETE audit rows for this task before INSERT.
      db.prepare('DELETE FROM audit_log WHERE task_id = ?').run(taskId);
      for (const ev of events) {
        const sqliteAt = normTsForAudit(ev.ts);
        const auditRow = auditRowFromEvent(ev, sqliteAt);
        db.prepare(
          `INSERT INTO audit_log (id, task_id, project_id, actor, event_type, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          auditRow.id,
          auditRow.task_id ?? taskId,
          auditRow.project_id ?? project.id,
          auditRow.actor,
          auditRow.event_type,
          auditRow.payload,
          auditRow.created_at ?? sqliteAt,
        );
      }
    })();
  } catch (err) {
    // FK / constraint failure — folder found but DB upsert failed
    swallow('tasks.reconcile_on_miss_upsert_failed', err);
    return { found: true, rebuildable: false, error: `upsert_failed: ${err.message}` };
  }

  const task = stmts.getTask.get(taskId) ?? null;
  if (!task) return { found: true, rebuildable: false, error: 'upsert_produced_no_row' };
  return { found: true, task };
}

export function requireTask(taskId) {
  const stmts = getTaskStatements();
  let task = stmts.getTask.get(taskId);
  if (!task) {
    // D2: reconcile-on-miss — attempt to rebuild from fs before returning 404.
    // CLUSTER B: distinguish no-folder (404) from found-but-unrebuildable (409/5xx).
    let reconcileResult;
    try {
      reconcileResult = reconcileTaskFromFs(taskId);
    } catch (err) {
      swallow('tasks.require_task_reconcile_failed', err);
      reconcileResult = { found: false };
    }

    if (!reconcileResult.found) {
      // True absence: no folder and no DB row
      return { status: 404, body: { error: 'task_not_found' }, task: null };
    }

    if (reconcileResult.rebuildable === false) {
      // Folder found but unrebuildable — loud 409 with diagnostics.
      // ROOT 4 (R7): includes diagnostics from id-mismatch detection so callers
      // can see folder_id vs requested_id without further inspection.
      console.error(
        `[requireTask] task_unrebuildable task_id=${taskId}` +
        ` error=${reconcileResult.error ?? 'unknown'}`,
      );
      return {
        status: 409,
        body: {
          error: 'task_unrebuildable',
          detail: reconcileResult.error ?? 'folder found but cannot be rebuilt',
          task_id: taskId,
          ...(reconcileResult.diagnostics ? { diagnostics: reconcileResult.diagnostics } : {}),
        },
        task: null,
      };
    }

    task = reconcileResult.task ?? null;
    if (!task) {
      // Should not happen, but guard for safety
      return { status: 404, body: { error: 'task_not_found' }, task: null };
    }
  }
  return { status: 0, task };
}

export function syncFiles(taskId) {
  // Step 1: README + folder creation (existing best-effort write).
  let result;
  try {
    result = syncTaskFileLifecycle({ taskId });
  } catch (err) {
    swallow('tasks.sync_files_failed', err);
    result = { queued: true, warning: err.message };
  }

  // Step 2: task.json sync — also best-effort, outside any SQLite transaction.
  // Errors are swallowed; the reconciler repairs drift on next boot.
  try {
    const stmts = getTaskStatements();
    const taskRow = stmts.getTask.get(taskId);
    if (!taskRow) return result;
    const project = stmts.getProject.get(taskRow.project_id);
    if (!project) return result;
    const projectDir = getProjectDir(project);
    if (!projectDir) return result;
    const phaseNumber = inferPhaseNumber(taskRow);
    const phaseDir = getPhaseDir(project, phaseNumber);
    if (!phaseDir) return result;
    const taskDir = findTaskFolderByUuid(phaseDir, taskId);
    if (!taskDir) return result;
    const projection = dbRowToTaskJson(taskRow, phaseNumber, project.slug ?? project.name);
    writeTaskJson(taskDir, projection);
  } catch (err) {
    swallow('tasks.task_json_sync_failed', err);
  }

  return result;
}

export function actorOwnsTask(task, actor) {
  if (!actor) return false;
  return sameAgent(task.assigned_to, actor.id);
}

export function actorCreatedTask(task, actor) {
  if (!actor) return false;
  return sameAgent(task.created_by, actor.id);
}

export function actorReviewsTask(task, actor) {
  if (!actor || !task.metadata) return false;
  let md;
  try { md = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata; }
  catch (err) { void err; return false; }
  return sameAgent(md?.reviewer_agent, actor.id);
}

export function phaseIdForProject(projectId, phaseNumber) {
  if (!projectId) return null;
  const stmts = getTaskStatements();
  const phases = stmts.listPhases.all(projectId);
  if (!phases.length) return null;
  // phase_number is 1-based; phases[] is ordinal-sorted ascending.
  const desired = phaseNumber || 1;
  const match = phases.find((p) => (p.ordinal || 0) === (desired - 1))
    || phases.find((p) => (p.ordinal || 0) === desired)
    || phases[Math.min(desired - 1, phases.length - 1)];
  return match ? match.id : null;
}

export function pickHint(status) {
  switch (status) {
    case 'pending': return 'Pending — call claim_task.';
    case 'claimed': return 'Claimed. Start with report_progress status=planning.';
    case 'in_progress': return 'Continue work, then submit_result when done.';
    case 'submitted': return 'Submitted. Call request_verification with a reviewer.';
    case 'review': return 'In review. Reviewer decides approve/reject.';
    case 'orphaned': return 'ORPHANED — previous owner went away. Call claim_orphan to adopt.';
    case 'approved': return 'Approved. Work is complete.';
    case 'rejected': return 'Rejected. Call task_reopen with a reason, then rework.';
    default: return 'Task retrieved. Decide the next lifecycle step from status.';
  }
}

export function priorityRank(p) {
  return { critical: 4, high: 3, normal: 2, medium: 2, low: 1 }[p] || 0;
}
