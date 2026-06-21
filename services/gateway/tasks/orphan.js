/**
 * Orphan state — Phase 5's Phase-6 interop hook.
 *
 * When a session dies, Phase 6's reaper detects the dead owner. If it
 * cannot find a reclaimable sibling session (another process from the
 * same base agent with a fresh heartbeat), it calls `orphanTask()`:
 * the row flips to status='orphaned' and its assigned_to is cleared
 * so nobody sees it as "mine, in-progress." A subsequent `claimOrphan()`
 * is the only path back to an owner, and it PRESERVES the journal —
 * the new claimer inherits everything the old owner logged plus an
 * explicit `handoff` entry documenting the transition.
 *
 * Events:
 *   - task.orphaned         (emitted by orphanTask)
 *   - task.orphan_claimed   (emitted by claimOrphan — distinct from
 *                            task.claimed because the lifecycle is
 *                            different: no 'claimed' status, prior
 *                            journal inherited, skip-to-in_progress)
 */

import { TaskClaimOrphanSchema } from '@cortex/core/schemas';
import { swallow } from '@cortex/sdk/errors';
import { getDb } from '@cortex/sdk/db';
import { randomUUID } from 'node:crypto';
import { getTaskStatements } from './statements.js';
import { emitTaskOrphaned, emitTaskOrphanClaimed } from './events.js';
import { getProjectDir } from './folders.js';
import { appendLedgerAndEvents } from './ledger.js';
import {
  syncFiles,
  resolveOrCreateTaskDir,
  removeCreatedTaskDir,
} from './_internals.js';

// Mirrors TaskOrphanedEventSchema's enum. Kept here so state-machine /
// sessions callers pass a typed reason rather than a free-form string
// that would fail schema validation at emit time.
const ORPHAN_REASONS = new Set([
  'agent_stale', 'session_expired', 'force_release', 'cancel',
]);

function badRequest(error, extras = {}) {
  return { status: 400, body: { error, ...extras } };
}
function notFound() {
  return { status: 404, body: { error: 'not_found' } };
}

/**
 * Flip a task to orphaned. Called by Phase 6's sessions reaper; also
 * callable by an admin HTTP path for force-orphan.
 *
 * Transition guard: only rows currently in claimed / in_progress /
 * submitted / review are orphanable. Terminal rows (approved, rejected,
 * cancelled, failed) or already-orphaned rows return 409.
 *
 * `skipEmit` — when true, the canonical task.orphaned event is NOT emitted
 * from this call. Used by the orphan-subscriber path: the sessions plane's
 * orphan-dispatcher already emitted task.orphaned (which is what triggered
 * the subscriber); a second emit here would double-count for downstream
 * consumers (dashboards, webhooks). Default false preserves the direct-call
 * contract (admin HTTP path, tests).
 *
 * @param {{ taskId: string, reason: 'agent_stale'|'session_expired'|'force_release'|'cancel', previousOwner?: string | null, skipEmit?: boolean }} args
 */
export function orphanTask({ taskId, reason, previousOwner = null, skipEmit = false } = {}) {
  if (!taskId) return badRequest('task_id required');
  if (!ORPHAN_REASONS.has(reason)) {
    return badRequest('invalid_reason', { reason, allowed: [...ORPHAN_REASONS] });
  }
  const stmts = getTaskStatements();
  const peek = stmts.getTask.get(taskId);
  if (!peek) return notFound();
  if (!['claimed', 'in_progress', 'submitted', 'review'].includes(peek.status)) {
    return {
      status: 409,
      body: { error: 'not_orphanable', current_status: peek.status },
    };
  }

  // Capture the prior owner BEFORE nulling assigned_to, and stash it in
  // metadata.previous_owner so claimOrphan can retrieve it later. This
  // keeps the orphaned row self-contained — the adopter doesn't need to
  // join against progress_reports or audit_log to figure out who had it.
  const priorOwner = previousOwner ?? peek.assigned_to ?? null;
  const db = getDb();
  // Task 120 (D2): orphanTask is a state transition (active → orphaned) and
  // must leave the same canonical trail as every transitions.js path — audit
  // row + per-project ledger.jsonl + per-task events.jsonl + fs_version bump,
  // ALL inside the flip transaction via the compensated appendLedgerAndEvents
  // (the reportProgress/rejectTask extend-the-existing-transaction pattern;
  // dualWrite cannot be reused verbatim because of the metadata stamp step).
  // projectDir-null guard: a project with no canonical FS home skips the
  // audit/ledger/events trio exactly like reportProgress/rejectTask do —
  // documented exemption in WRITERS-INVENTORY.md.
  const orphanProject = stmts.getProject.get(peek.project_id);
  const orphanProjectDir = getProjectDir(orphanProject);
  let orphanResolved = null;
  // R4 (R3 #4/#7): undo handle captured outside txn closure.
  let orphanAppendUndo = null;
  const orphanLine = {
    ts: new Date().toISOString(),
    task_id: taskId,
    project_id: peek.project_id,
    actor: 'system',
    event_type: 'task_orphaned',
    from_status: peek.status,
    to_status: 'orphaned',
    data: { title: peek.title, previous_owner: priorOwner, reason },
  };
  const tx = db.transaction(() => {
    const info = stmts.orphanTask.run(taskId);
    if (Number(info.changes) === 0) return { flipped: false };
    // Persist prior owner + reason into metadata for claimOrphan to recover.
    // Uses the prepared stampOrphanMetadata statement (json_set preserves
    // other keys).
    try {
      stmts.stampOrphanMetadata.run(priorOwner, reason, taskId);
    } catch (err) {
      // Best-effort: the flip already landed. A failing metadata stamp
      // means claimOrphan can't recover the prior owner, but the row is
      // still orphaned — operators see the gap via the metric.
      swallow('tasks.orphan_metadata_stamp_failed', err);
    }
    // Phase 1b §4: the flip changes task.json-projected fields (status,
    // assigned_to) — bump fs_version in the SAME transaction.
    stmts.bumpFsVersion.run(taskId);
    if (orphanProjectDir) {
      stmts.insertAudit.run(
        randomUUID(), taskId, peek.project_id,
        'system', 'task_orphaned',
        JSON.stringify({ title: peek.title, previous_owner: priorOwner, reason }),
      );
      // Compensated dual append LAST inside the transaction (1b BUG-A).
      // R4: capture undo handle.
      orphanAppendUndo = appendLedgerAndEvents(
        orphanProjectDir, orphanResolved.taskDir, orphanLine,
      ).undo;
    }
    return { flipped: true };
  });
  let result;
  try {
    if (orphanProjectDir) orphanResolved = resolveOrCreateTaskDir(orphanProject, peek);
    result = tx();
  } catch (err) {
    let compensationErr = null;
    try { if (orphanAppendUndo) orphanAppendUndo(); }
    catch (restoreErr) { compensationErr = restoreErr; }
    removeCreatedTaskDir(orphanResolved);
    if (compensationErr) {
      swallow('tasks.orphan_tx_failed', err);
      return { status: 500, body: { error: 'orphan_failed', message: compensationErr.message } };
    }
    swallow('tasks.orphan_tx_failed', err);
    return { status: 500, body: { error: 'orphan_failed', message: err.message } };
  }
  if (!result.flipped) {
    // Race: someone else transitioned the row between our peek and our
    // UPDATE. Return 409 so the reaper retries with a fresh read. A folder
    // created for this attempt is removed (zero residue on the no-op path).
    removeCreatedTaskDir(orphanResolved);
    return { status: 409, body: { error: 'state_changed_concurrently' } };
  }
  // Task 120 (1b BUG-B): the fs_version bump must be matched by a task.json
  // re-render so DB fs_version == task.json fs_version after the flip.
  syncFiles(taskId);
  if (!skipEmit) {
    try {
      emitTaskOrphaned({
        taskId,
        previousAgent: priorOwner,
        previousStatus: peek.status,
        reason,
      });
    } catch (err) {
      // emit validates against TaskOrphanedEventSchema; a bad payload
      // throws. We swallow so a schema drift doesn't take down the
      // reaper, and the row stays orphaned (the DB is authoritative).
      swallow('tasks.orphaned_emit_failed', err);
    }
  }
  const updated = stmts.getTask.get(taskId);
  return {
    status: 200,
    body: {
      task_id: taskId,
      status: updated.status,
      previous_agent: priorOwner,
      previous_status: peek.status,
      reason,
    },
  };
}

/**
 * Adopt an orphaned task. Writes a 'handoff' journal entry in the same
 * transaction as the ownership flip, then returns the full hydrated row
 * so the new claimer immediately sees the inherited journal.
 *
 * Short-circuits orphaned → in_progress (skipping 'claimed') because the
 * claimer is resuming work, not starting fresh.
 *
 * @param {{ taskId: string, body: unknown, actor: { id: string } }} args
 */
export function claimOrphan({ taskId, body, actor } = {}) {
  if (!actor || !actor.id) {
    return { status: 401, body: { error: 'missing or invalid token' } };
  }
  const parsed = TaskClaimOrphanSchema.safeParse(body || {});
  if (!parsed.success) {
    return badRequest('invalid_body', { issues: parsed.error.issues });
  }

  const stmts = getTaskStatements();
  // FK pre-check — claimOrphanedTask writes tasks.assigned_to which
  // references agents(id). A ghost adopter produces an opaque FK error
  // otherwise; surface a clear 400 so the caller knows to register first.
  if (!stmts.getAgentById.get(actor.id)) {
    return badRequest('unknown_agent', {
      agent_id: actor.id,
      hint: 'register the agent (POST /v1/api/agents) before claiming',
    });
  }
  const peek = stmts.getTask.get(taskId);
  if (!peek) return notFound();
  if (peek.status !== 'orphaned') {
    return {
      status: 409,
      body: { error: 'not_orphaned', current_status: peek.status },
    };
  }
  const previousOwner = extractPreviousOwnerFromMetadata(peek) || null;

  const db = getDb();
  // Task 120 (D2): claimOrphan is a state transition (orphaned → in_progress)
  // and leaves the full canonical trail in the SAME transaction as the
  // ownership flip — audit row + ledger.jsonl + per-task events.jsonl via the
  // compensated appendLedgerAndEvents, plus the fs_version bump. Same
  // extend-the-existing-transaction pattern as orphanTask above (the handoff
  // journal insert prevents reusing dualWrite verbatim).
  const claimProject = stmts.getProject.get(peek.project_id);
  const claimProjectDir = getProjectDir(claimProject);
  let claimResolved = null;
  // R4 (R3 #4/#7): undo handle captured outside txn closure.
  let claimAppendUndo = null;
  const claimLine = {
    ts: new Date().toISOString(),
    task_id: taskId,
    project_id: peek.project_id,
    actor: actor.id,
    event_type: 'task_orphan_claimed',
    from_status: 'orphaned',
    to_status: 'in_progress',
    data: { title: peek.title, assigned_to: actor.id, previous_owner: previousOwner },
  };
  const tx = db.transaction(() => {
    const claimInfo = stmts.claimOrphanedTask.run(actor.id, taskId);
    if (Number(claimInfo.changes) === 0) return { claimed: false };
    // In-transaction handoff journal row. The new owner's first read of
    // the journal will include this entry, making the transition
    // explicit + auditable.
    const handoffId = randomUUID();
    const summary =
      `Handoff from dead owner ${previousOwner || 'unknown'} to ${actor.id}. ` +
      `Prior status: orphaned. Reclaimed at ${new Date().toISOString()}.`;
    const metadata = JSON.stringify({
      previous_owner: previousOwner,
      new_owner: actor.id,
      kind: 'orphan_adoption',
    });
    try {
      stmts.insertTaskJournal.run(
        handoffId, taskId, 'handoff', summary, '[]', metadata, actor.id,
      );
    } catch (err) {
      // A broken journal insert MUST fail the transaction — the claim
      // is only correct if the handoff entry lands. Re-throw so the
      // outer `try` sees it and rolls back the UPDATE above.
      swallow('tasks.orphan_handoff_failed', err);
      throw err;
    }
    // Phase 1b §4: the adoption changes task.json-projected fields (status,
    // assigned_to, claimed_at) — bump fs_version in the SAME transaction.
    stmts.bumpFsVersion.run(taskId);
    if (claimProjectDir) {
      stmts.insertAudit.run(
        randomUUID(), taskId, peek.project_id,
        actor.id, 'task_orphan_claimed',
        JSON.stringify({ title: peek.title, assigned_to: actor.id, previous_owner: previousOwner }),
      );
      // Compensated dual append LAST inside the transaction (1b BUG-A).
      // R4: capture undo handle.
      claimAppendUndo = appendLedgerAndEvents(
        claimProjectDir, claimResolved.taskDir, claimLine,
      ).undo;
    }
    return { claimed: true };
  });

  let result;
  try {
    if (claimProjectDir) claimResolved = resolveOrCreateTaskDir(claimProject, peek);
    result = tx();
  } catch (err) {
    let compensationErr = null;
    try { if (claimAppendUndo) claimAppendUndo(); }
    catch (restoreErr) { compensationErr = restoreErr; }
    removeCreatedTaskDir(claimResolved);
    if (compensationErr) {
      swallow('tasks.claim_orphan_tx_failed', err);
      return { status: 500, body: { error: 'claim_failed', message: compensationErr.message } };
    }
    swallow('tasks.claim_orphan_tx_failed', err);
    return { status: 500, body: { error: 'claim_failed', message: err.message } };
  }
  if (!result.claimed) {
    removeCreatedTaskDir(claimResolved);
    return { status: 409, body: { error: 'state_changed_concurrently' } };
  }

  // Task 120 (1b BUG-B): match the fs_version bump with a task.json re-render.
  syncFiles(taskId);

  const updated = stmts.getTask.get(taskId);
  const journalRows = stmts.journalByTaskAsc.all(taskId);
  try {
    emitTaskOrphanClaimed({
      taskId,
      newOwner: actor.id,
      previousOwner: previousOwner ?? null,
      journalEntries: journalRows.length,
    });
  } catch (err) {
    swallow('tasks.orphan_claimed_emit_failed', err);
  }
  return {
    status: 200,
    body: {
      task_id: taskId,
      status: updated.status,
      assigned_to: updated.assigned_to,
      previous_owner: previousOwner ?? null,
      inherited_journal_entries: journalRows.length,
      next_step_hint:
        'Orphan adopted. Read the journal, continue the previous ' +
        "owner's work, then submit_result.",
    },
  };
}

// -- private helpers --------------------------------------------------------

/**
 * orphanTask clears tasks.assigned_to. To preserve the previous owner
 * across the orphan → adopt boundary we fold it into tasks.metadata
 * before clearing. Here we extract it during claimOrphan so the handoff
 * journal row + the emitted event both name the right agent.
 *
 * The current schema doesn't persist previous_owner in metadata
 * (simplification) — callers of orphanTask can pass `previousOwner`
 * directly, and the event captures it there. If no caller-provided
 * hint is available, we read it from the most recent progress_reports
 * row as a best-effort fallback.
 */
function extractPreviousOwnerFromMetadata(task) {
  if (!task || !task.metadata) return null;
  try {
    const md = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata;
    return md?.previous_owner || null;
  } catch (err) {
    void err; // Rule 2.B — reference the caught error.
    return null;
  }
}
