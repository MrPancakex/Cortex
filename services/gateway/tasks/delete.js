import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { TaskDeleteRequestSchema } from '@cortex/core/schemas';
import { getDb } from '@cortex/sdk/db';
import { swallow } from '@cortex/sdk/errors';
import { getTaskStatements } from './statements.js';
import {
  ok,
  badRequest,
  forbidden,
  conflict,
  hint,
  requireTask,
  syncFiles,
  actorOwnsTask,
  actorCreatedTask,
  resolveTaskPhaseDir,
  resolveOrCreateTaskDir,
  removeCreatedTaskDir,
  removeCreatedParentDirs,
} from './_internals.js';
import { dualWriteNoGuard } from './_dualwrite.js';
import { appendLedgerAndEvents } from './ledger.js';
import { getProjectDir } from './folders.js';
import {
  emitTaskDeleteRequested,
  emitTaskDeleteDenied,
  emitTaskDeleted,
} from './events.js';

// Delete-request approval workflow.
//
// The frontend has had request/approve/deny + bulk delete UI since the
// cutover; no backend ever existed for it. Side-data is metadata JSON
// (codebase convention); approve-delete renames the folder " (deleted)"
// (never rm -rf) then hard-deletes the row.

export function requestTaskDelete({ taskId, body, actor, isAdmin = false }) {
  const parsed = TaskDeleteRequestSchema.safeParse(body || {});
  if (!parsed.success) return badRequest('invalid_body', { issues: parsed.error.issues });
  const r = requireTask(taskId);
  if (r.status) return { status: r.status, body: r.body };
  const task = r.task;
  if (!isAdmin && !actorOwnsTask(task, actor) && !actorCreatedTask(task, actor)) {
    return forbidden('not_owner_or_creator');
  }
  const stmts = getTaskStatements();
  const deleteReqActor = actor?.id || 'admin';
  const deleteReqTs = new Date().toISOString();
  try {
    dualWriteNoGuard({
      taskRow: task,
      eventType: 'task_delete_requested',
      toStatus: task.status,
      actor: deleteReqActor,
      data: { actor: deleteReqActor },
      mutateFn: () => {
        const info = stmts.requestTaskDelete.run(deleteReqTs, deleteReqActor, taskId);
        if (Number(info.changes) === 0) throw new Error('delete_already_requested');
      },
    });
  } catch (err) {
    if (err.message === 'delete_already_requested') return conflict('delete_already_requested');
    swallow('tasks.delete_req_dualwrite_failed', err);
    return { status: 500, body: { error: 'delete_request_failed', message: err.message } };
  }
  // Phase 1b rework (BUG B): the request bumps fs_version and updates
  // updated_at (a projected/compared field), so re-render task.json to keep
  // DB fs_version == task.json fs_version. Side-effect only.
  syncFiles(taskId);
  try {
    emitTaskDeleteRequested({ taskId, actor: deleteReqActor });
  } catch (err) { swallow('tasks.delete_requested_emit_failed', err); }
  return ok({
    task_id: taskId,
    delete_requested: true,
    ...hint('Deletion requested. An admin must approve-delete or deny-delete.'),
  });
}

const DELETED_SUFFIX = ' (deleted)';

// secureDeletedFolder — Task 120 (D3) step 1 of the approved-delete ordering.
//
// The final event trail of a deleted task must live in the renamed
// " (deleted)" folder, and renameOnDelete-style resolution needs the DB row —
// which is GONE after hardDeleteTask. So the folder is secured BEFORE the
// transaction, fail-loud, and fully compensable:
//   - live folder present  → renameSync to " (deleted)" (throws → abort, no
//     DB mutation has happened); undo = rename back.
//   - folder absent        → CREATE the " (deleted)" folder (D4
//     create-or-fail-loud — the event trail always has its canonical home);
//     undo = remove the created folder.
//   - already " (deleted)" → reuse as-is (idempotent); no undo needed.
//   - no project/phase dir → no canonical FS home exists for this project at
//     all; returns deletedDir:null and the caller skips the ledger/events
//     appends (same exemption as every projectDir-null guard in this file).
//
// Returns { deletedDir, folderResult, undo }. Throws on any rename/mkdir
// failure — the caller surfaces 500 with the task row untouched.
function secureDeletedFolder(project, taskRow) {
  const phaseDir = resolveTaskPhaseDir(project, taskRow);
  if (!phaseDir) {
    return {
      deletedDir: null,
      folderResult: { renamed: false, reason: 'phase_dir_unknown' },
      undo: null,
    };
  }
  const resolved = resolveOrCreateTaskDir(project, taskRow);
  if (resolved.taskDir.endsWith(DELETED_SUFFIX)) {
    // R3 (FIX 7): a title that legitimately ends " (deleted)" reaches this
    // branch when its folder was absent — resolveOrCreateTaskDir creates it,
    // so resolved.created is true. Pre-R3 we returned undo:null and stranded
    // that folder on any later failure. Now: if THIS attempt created the
    // folder, return a real undo handler that removes it (and created parents)
    // so the zero-residue delete-failure guarantee holds.
    const undo = resolved.created
      ? () => { removeCreatedTaskDir(resolved); }
      : null;
    return {
      deletedDir: resolved.taskDir,
      folderResult: { renamed: false, reason: 'already_deleted' },
      undo,
    };
  }
  const target = `${resolved.taskDir}${DELETED_SUFFIX}`;
  try {
    fs.renameSync(resolved.taskDir, target);
  } catch (err) {
    // Fail LOUD (D5c): a rename failure aborts the delete before any DB
    // mutation. If the folder was created just above for this delete, remove
    // it so the aborted operation leaves zero residue.
    removeCreatedTaskDir(resolved);
    throw err;
  }
  return {
    deletedDir: target,
    folderResult: { renamed: true, from: resolved.taskDir, to: target },
    undo: () => {
      try {
        if (resolved.created) fs.rmSync(target, { recursive: true, force: true });
        else fs.renameSync(target, resolved.taskDir);
      } catch (err) { swallow('tasks.delete_folder_undo_failed', err); }
      // R1 (finding 6): a delete on a missing phase tree had its phase
      // ancestors created by the resolver above — remove them too (empty-
      // check; pre-existing dirs are never in createdDirs).
      removeCreatedParentDirs(resolved.createdDirs);
    },
  };
}

// performApprovedTaskDelete — Task 120 (D3): the shared approved-delete core
// used by approveTaskDelete AND approveAllTaskDeletes (one mechanism, not two).
//
// Ordering argument (documented in WRITERS-INVENTORY.md):
//   1. Secure the " (deleted)" folder (compensable fs step, above).
//   2. In ONE SQLite transaction: insertAudit FIRST (audit_log.task_id
//      REFERENCES tasks(id) ON DELETE CASCADE — insert after the DELETE would
//      violate the FK; the CASCADE removes the row again when the task row
//      goes, leaving ledger.jsonl + events.jsonl as the durable trail), then
//      the compensated appendLedgerAndEvents (the task_deleted line lands in
//      ledger.jsonl AND the renamed folder's events.jsonl — the event trail is
//      on disk BEFORE the row removal), then the GUARDED hardDeleteTask LAST.
//   3. Any failure: ledger.jsonl + events.jsonl are restored byte-exact —
//      by appendLedgerAndEvents itself when the APPEND failed, or via its
//      held undo handle when a LATER step failed (hardDeleteTask throw /
//      0-changes guard; R1) — SQLite rolled the row/audit back, and undo()
//      renames the folder back (or removes a created one) — zero residue,
//      task fully intact.
//
// Success leaves the consistent final state D3 demands: row gone, folder
// renamed " (deleted)", events.jsonl inside it ending with task_deleted.
function performApprovedTaskDelete(taskRow, actorId) {
  const stmts = getTaskStatements();
  const db = getDb();
  const project = stmts.getProject.get(taskRow.project_id);
  const projectDir = getProjectDir(project);

  const { deletedDir, folderResult, undo } = secureDeletedFolder(project, taskRow);

  const deleteLine = {
    ts: new Date().toISOString(),
    task_id: taskRow.id,
    project_id: taskRow.project_id,
    actor: actorId,
    event_type: 'task_deleted',
    from_status: taskRow.status,
    to_status: taskRow.status,
    data: { title: taskRow.title, actor: actorId },
  };
  let appendUndo = null;
  try {
    db.transaction(() => {
      stmts.insertAudit.run(
        randomUUID(), taskRow.id, taskRow.project_id,
        actorId, 'task_deleted', JSON.stringify({ title: taskRow.title, actor: actorId }),
      );
      // Event trail BEFORE row removal — compensated dual append into the
      // secured " (deleted)" folder. R1 (findings 2/4): hold the undo
      // handle — the append can SUCCEED and a LATER step (the guarded hard
      // delete: throw or 0-changes) still fail; the outer catch must then
      // restore BOTH files or the rolled-back row keeps a phantom
      // task_deleted trail. appendLedgerAndEvents still self-compensates
      // append-time failures (appendUndo stays null on that path).
      if (projectDir) {
        appendUndo = appendLedgerAndEvents(projectDir, deletedDir, deleteLine).undo;
      }
      const info = stmts.hardDeleteTask.run(taskRow.id);
      if (Number(info.changes) === 0) throw new Error('no_pending_delete_request');
    })();
  } catch (err) {
    // Restore events.jsonl + ledger.jsonl FIRST — the events path lives
    // inside the still-renamed " (deleted)" folder, so the byte-restore must
    // run before undo() renames the folder back.
    //
    // R3 (R2 #2c): a compensation failure is LOUD now — restoreLen
    // throws 'ledger_compensation_failed' (typically: append-only ledger,
    // truncate EPERM). The folder undo must STILL run so the only possible
    // residue is the ledger line itself (the single accepted residue class;
    // the boot parity check audit↔ledger is the recovery path) — then the
    // compensation failure wins the throw so the caller surfaces it.
    let compensationErr = null;
    try {
      if (appendUndo) appendUndo();
    } catch (restoreErr) {
      compensationErr = restoreErr;
    }
    if (undo) undo();
    if (compensationErr) throw compensationErr;
    throw err;
  }
  return folderResult;
}

export function approveTaskDelete({ taskId, actor, isAdmin = false }) {
  if (!isAdmin) return forbidden('admin_only');
  const r = requireTask(taskId);
  if (r.status) return { status: r.status, body: r.body };
  // Reject BEFORE any disk mutation: a rename on the no-pending-request
  // path would label a live task's folder " (deleted)" for an operation
  // that 409s. Check the flag on the already-loaded row.
  let pending = false;
  try {
    const md = typeof r.task.metadata === 'string'
      ? JSON.parse(r.task.metadata) : r.task.metadata;
    pending = !!md?.delete_requested_at;
  } catch (err) { void err; pending = false; }
  if (!pending) return conflict('no_pending_delete_request');
  const approveDeleteActor = actor?.id || 'admin';
  let folder = null;
  try {
    folder = performApprovedTaskDelete(r.task, approveDeleteActor);
  } catch (err) {
    if (err.message === 'no_pending_delete_request') return conflict('no_pending_delete_request');
    swallow('tasks.approve_delete_dualwrite_failed', err);
    return { status: 500, body: { error: 'approve_delete_failed', message: err.message } };
  }
  try {
    emitTaskDeleted({ taskId, actor: approveDeleteActor });
  } catch (err) { swallow('tasks.deleted_emit_failed', err); }
  return ok({
    task_id: taskId,
    deleted: true,
    folder_rename: folder,
    ...hint('Task deleted. The folder was renamed " (deleted)", not removed.'),
  });
}

export function denyTaskDelete({ taskId, actor, isAdmin = false }) {
  if (!isAdmin) return forbidden('admin_only');
  const r = requireTask(taskId);
  if (r.status) return { status: r.status, body: r.body };
  const stmts = getTaskStatements();
  const denyDeleteActor = actor?.id || 'admin';
  try {
    dualWriteNoGuard({
      taskRow: r.task,
      eventType: 'task_delete_denied',
      toStatus: r.task.status,
      actor: denyDeleteActor,
      data: { actor: denyDeleteActor },
      mutateFn: () => {
        const info = stmts.denyTaskDelete.run(taskId);
        if (Number(info.changes) === 0) throw new Error('no_pending_delete_request');
      },
    });
  } catch (err) {
    if (err.message === 'no_pending_delete_request') return conflict('no_pending_delete_request');
    swallow('tasks.deny_delete_dualwrite_failed', err);
    return { status: 500, body: { error: 'deny_delete_failed', message: err.message } };
  }
  // Phase 1b rework (BUG B): deny bumps fs_version and updates updated_at, so
  // re-render task.json to keep DB fs_version == task.json fs_version.
  syncFiles(taskId);
  try {
    emitTaskDeleteDenied({ taskId, actor: denyDeleteActor });
  } catch (err) { swallow('tasks.delete_denied_emit_failed', err); }
  return ok({
    task_id: taskId,
    delete_denied: true,
    ...hint('Deletion request cleared. Task remains.'),
  });
}

export function approveAllTaskDeletes({ actor, isAdmin = false }) {
  if (!isAdmin) return forbidden('admin_only');
  const stmts = getTaskStatements();
  const pending = stmts.listDeleteRequests.all();
  const deleted = [];
  const bulkApproveActor = actor?.id || 'admin';
  // R4 (R3 #8): compensation failures must be distinguishable in the
  // response. Track per-item failures separately from telemetry-only skips.
  const failedIds = [];
  const failedDetails = [];
  for (const row of pending) {
    // Task 120 (D2/D3): the bulk path runs the SAME approved-delete core as
    // the single-task path (performApprovedTaskDelete) — secured " (deleted)"
    // folder, audit + compensated ledger/events appends BEFORE the guarded
    // hard delete, full per-task compensation on failure. A failing task is
    // skipped LOUDLY (swallow telemetry) and left fully intact; the rest of
    // the batch proceeds (each task is its own atomic unit).
    //
    // R4: distinguish LEDGER_COMPENSATION_FAILED from ordinary failures —
    // the compensation class requires operator recovery (boot parity check);
    // ordinary failures are transient/retryable. Both are surfaced in the
    // response body via failed_ids + failed_details so callers know which
    // tasks need attention and which are retryable.
    try {
      performApprovedTaskDelete(row, bulkApproveActor);
      deleted.push(row.id);
    } catch (err) {
      swallow('tasks.bulk_approve_delete_failed', err);
      failedIds.push(row.id);
      failedDetails.push({
        id: row.id,
        error_code: err.code ?? 'delete_failed',
        error: err.message,
      });
      continue;
    }
    try {
      emitTaskDeleted({ taskId: row.id, actor: bulkApproveActor });
    } catch (err) { swallow('tasks.deleted_emit_failed', err); }
  }
  return ok({
    deleted_count: deleted.length,
    deleted_ids: deleted,
    ...(failedIds.length > 0 ? {
      failed_count: failedIds.length,
      failed_ids: failedIds,
      failed_details: failedDetails,
    } : {}),
    ...hint(`Approved ${deleted.length} pending deletion(s).`),
  });
}

export function denyAllTaskDeletes({ actor, isAdmin = false }) {
  if (!isAdmin) return forbidden('admin_only');
  const stmts = getTaskStatements();
  const pending = stmts.listDeleteRequests.all();
  const denied = [];
  const bulkDenyActor = actor?.id || 'admin';
  // R5 (R4): per-item failures must be surfaced in the response — same
  // pattern as approveAllTaskDeletes (~:1485-1525). Track failed_ids and
  // failed_details so callers can distinguish which tasks need attention.
  const failedIds = [];
  const failedDetails = [];
  for (const row of pending) {
    // Task 120 (D2): the bulk deny path runs the SAME compensated dual-write
    // as the single-task denyTaskDelete — guarded mutate + fs_version bump +
    // audit + ledger.jsonl + per-task events.jsonl, all in one transaction.
    // A failing task is skipped loudly and left intact; the batch proceeds.
    try {
      dualWriteNoGuard({
        taskRow: row,
        eventType: 'task_delete_denied',
        toStatus: row.status,
        actor: bulkDenyActor,
        data: { actor: bulkDenyActor },
        mutateFn: () => {
          const info = stmts.denyTaskDelete.run(row.id);
          if (Number(info.changes) === 0) throw new Error('no_changes');
        },
      });
      denied.push(row.id);
    } catch (err) {
      swallow('tasks.bulk_deny_delete_failed', err);
      failedIds.push(row.id);
      failedDetails.push({
        id: row.id,
        error_code: err.code ?? 'deny_failed',
        error: err.message,
      });
      continue;
    }
    // Task 120 (1b BUG-B carve): the deny bumps fs_version and touches
    // updated_at — re-render task.json so DB fs_version == task.json fs_version.
    syncFiles(row.id);
    try {
      emitTaskDeleteDenied({ taskId: row.id, actor: bulkDenyActor });
    } catch (err) { swallow('tasks.delete_denied_emit_failed', err); }
  }
  return ok({
    denied_count: denied.length,
    denied_ids: denied,
    ...(failedIds.length > 0 ? {
      failed_count: failedIds.length,
      failed_ids: failedIds,
      failed_details: failedDetails,
    } : {}),
    ...hint(`Cleared ${denied.length} pending deletion request(s).`),
  });
}
