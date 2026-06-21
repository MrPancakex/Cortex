import { randomUUID } from 'node:crypto';
import { getDb } from '@cortex/sdk/db';
import { getTaskStatements } from './statements.js';
import {
  resolveOrCreateTaskDir,
  removeCreatedTaskDir,
} from './_internals.js';
import { appendLedgerAndEvents } from './ledger.js';
import { getProjectDir } from './folders.js';

// -- dualWrite helper (LEDGER-SCHEMA.md §3.1) -----------------------------
//
// Wraps a single state-mutating statement inside a db.transaction that ALSO
// writes an audit_log row and appends a ledger.jsonl line. All three succeed
// or all three roll back (Case A from §3.2). appendLedger is LAST inside the
// transaction body per §3.1 line 547.
//
// Use dualWrite() for single-mutation transitions. For transitions that
// already have an outer db.transaction() (reportProgress, rejectTask), extend
// that transaction body directly — nested db.transaction() calls would
// deadlock on bun:sqlite.
//
// @param {object} opts
// @param {object} opts.taskRow      — DB row before mutation (status = from_status)
// @param {string} opts.eventType    — ledger event_type string (§6 table)
// @param {string} opts.toStatus     — status after transition (same as from for no-op)
// @param {string} opts.actor        — agent id or 'system'/'admin'
// @param {object} opts.data         — extra payload (title always added internally)
// @param {object} opts.mutateStmt   — prepared statement whose .run() mutates the row
// @param {Array}  opts.mutateParams — positional params passed to mutateStmt.run()
// @throws {Error} 'state_guard_failed' if mutateStmt.run() reports 0 changes
// @throws {Error} 'project_dir_unknown' if the project root cannot be resolved
// @throws any error from appendLedger (causes full rollback)
export function dualWrite({ taskRow, eventType, toStatus, actor, data, mutateStmt, mutateParams }) {
  const db = getDb();
  const stmts = getTaskStatements();
  const project = stmts.getProject.get(taskRow.project_id);
  const projectDir = getProjectDir(project);
  if (!projectDir) throw new Error('project_dir_unknown');
  // Task 120 (D4 — no silent skips): resolve the per-task folder OUTSIDE the
  // transaction, CREATING it when absent (create-or-fail-loud). Phase 1b's
  // null → "skip the per-task append" path is gone: the events.jsonl append
  // is never silently skipped. A creation that the failing transaction
  // strands is compensated below (removeCreatedTaskDir).
  const resolved = resolveOrCreateTaskDir(project, taskRow);

  const line = {
    ts: new Date().toISOString(),
    task_id: taskRow.id,
    project_id: taskRow.project_id,
    actor: actor ?? 'system',
    event_type: eventType,
    from_status: taskRow.status,
    to_status: toStatus,
    data: { title: taskRow.title, ...data },
  };

  // R4: capture the appendLedgerAndEvents undo handle outside
  // the transaction closure so a post-append failure (e.g. SQLite commit
  // throw) can restore both files before rethrowing. appendLedgerAndEvents is
  // last in the txn body; appendUndo is only non-null when the append itself
  // succeeded (self-compensation handles the append-throws-during case).
  let appendUndo = null;
  try {
    db.transaction(() => {
      const info = mutateStmt.run(...mutateParams);
      if (Number(info.changes) === 0) throw new Error('state_guard_failed');
      // Phase 1b §4: bump fs_version by exactly 1 on every state-changing FS
      // write, in the SAME transaction, so the version-gated FS-wins reconcile
      // is safe (a folder edit with a bumped fs_version overrides the DB; one
      // without is correctly skipped). The bumped value flows to task.json via
      // syncFiles → dbRowToTaskJson after commit. EVERY dualWrite caller mutates
      // a task.json-projected field (status / assigned_to / timestamps) and runs
      // syncFiles after commit, so the bump is unconditional here.
      stmts.bumpFsVersion.run(taskRow.id);
      stmts.insertAudit.run(
        randomUUID(),
        taskRow.id,
        taskRow.project_id,
        actor ?? 'system',
        eventType,
        JSON.stringify({ title: taskRow.title, ...data }),
      );
      // Phase 1b rework (BUG A): the per-project ledger.jsonl + per-task
      // events.jsonl appends are now a COMPENSATED unit — if either throws, both
      // files are restored to their pre-append byte lengths before the error
      // rethrows and SQLite rolls back, so a failed transition leaves zero FS
      // residue (no phantom ledger-only line). LAST inside the txn.
      appendUndo = appendLedgerAndEvents(projectDir, resolved.taskDir, line).undo;
    })();
  } catch (err) {
    // Task 120: if the folder was created for THIS transition and the
    // transaction failed, remove it — zero filesystem residue on rollback.
    // R4: also invoke the append undo handle when the append succeeded but
    // a LATER step (e.g. SQLite commit itself) threw — restores both files
    // so the documented residue class (ledger-only at most) is true.
    let compensationErr = null;
    try { if (appendUndo) appendUndo(); }
    catch (restoreErr) { compensationErr = restoreErr; }
    removeCreatedTaskDir(resolved);
    if (compensationErr) throw compensationErr;
    throw err;
  }
}

// dualWriteNoGuard: like dualWrite but skips the changes===0 check.
// Used for INSERT-based operations (createTask) and metadata-only updates
// that don't have a status WHERE guard.
//
// Phase 1b rework (BUG B): `bumpVersion` (default true) gates ONLY the
// fs_version bump. An append-only transition that changes NO task.json-derived
// field (the bare-comment case — task_commented inserts a task_comments row but
// touches no projected tasks column, not even updated_at) must NOT bump
// fs_version: a bump with no corresponding task.json content change would push
// the DB fs_version ahead of task.json's, falsely making the DB "strictly
// ahead" and causing the §4 reconciler to skip legitimate later FS edits.
// Crucially `bumpVersion:false` does NOT skip the events.jsonl append — the
// audit row is still written, and per-task events↔audit parity (test 1b.4)
// requires the matching events line. So events append is unconditional;
// only the version bump is gated.
export function dualWriteNoGuard({
  taskRow,
  eventType,
  toStatus,
  actor,
  data,
  mutateFn,
  bumpVersion = true,
}) {
  const db = getDb();
  const stmts = getTaskStatements();
  const project = stmts.getProject.get(taskRow.project_id);
  const projectDir = getProjectDir(project);
  if (!projectDir) throw new Error('project_dir_unknown');
  // Task 120 (D4): create-or-fail-loud, never skip (see dualWrite).
  const resolved = resolveOrCreateTaskDir(project, taskRow);

  const line = {
    ts: new Date().toISOString(),
    task_id: taskRow.id,
    project_id: taskRow.project_id,
    actor: actor ?? 'system',
    event_type: eventType,
    from_status: taskRow.status,
    to_status: toStatus,
    data: { title: taskRow.title, ...data },
  };

  // R4: same undo-handle pattern as dualWrite — capture
  // outside the closure so a post-append SQLite-commit failure can restore
  // both files.
  let appendUndo = null;
  try {
    db.transaction(() => {
      mutateFn();
      // Phase 1b §4: bump fs_version by exactly 1 (see dualWrite for rationale),
      // UNLESS this is an append-only transition with no task.json change.
      if (bumpVersion) stmts.bumpFsVersion.run(taskRow.id);
      stmts.insertAudit.run(
        randomUUID(),
        taskRow.id,
        taskRow.project_id,
        actor ?? 'system',
        eventType,
        JSON.stringify({ title: taskRow.title, ...data }),
      );
      // Phase 1b rework (BUG A): compensated dual append (see dualWrite).
      appendUndo = appendLedgerAndEvents(projectDir, resolved.taskDir, line).undo;
    })();
  } catch (err) {
    let compensationErr = null;
    try { if (appendUndo) appendUndo(); }
    catch (restoreErr) { compensationErr = restoreErr; }
    removeCreatedTaskDir(resolved);
    if (compensationErr) throw compensationErr;
    throw err;
  }
  // R3 (FIX 4): expose resolved so callers that skip syncFiles (e.g. commentTask
  // with bumpVersion:false) can detect when the folder was freshly created and
  // render the missing task.json without bumping fs_version.
  return resolved;
}
