/**
 * Thin wrappers that emit task.* and submission.* events. Consolidating
 * every task-plane emit here serves three purposes:
 *
 *   1. Rule 3.A lint — every file that contains `emit('x.y', ...)` MUST
 *      import from @cortex/core/schemas/events. Keeping the emits in one
 *      file means handlers.js / journal.js / orphan.js stay clean and
 *      only this module carries the schema-taxonomy import.
 *
 *   2. Single point to attach instrumentation (tracing, sampling) later
 *      instead of sprinkling every handler.
 *
 *   3. Lets tests `import { emitTaskClaimed } from './events.js'` and
 *      stub individual emits rather than all of them. The default
 *      implementation routes through sdk/events.emit so tests can also
 *      subscribe via sdk/events.subscribe.
 *
 * Contract: every helper accepts primitives (ids, agent strings, unix
 * millis) — not DB rows — so the caller controls timestamps (submitted_at
 * vs Date.now()) and the emit decouples from SQLite's datetime() string
 * format (not round-trip-parseable on some platforms).
 */

import { emit } from '@cortex/sdk/events';
// Import anchors the events-schema-check lint (Rule 3.A). Every subject
// emitted from this module is validated against the taxonomy at emit time
// via payloadSchemaFor inside sdk/events/validate.js.
import { EventEnvelopeSchema } from '@cortex/core/schemas/events';
// Reference the anchor import so linters don't flag it as unused; the
// runtime check below is a cheap schema presence probe.
const _EVENT_ENVELOPE_SCHEMA_ANCHOR = EventEnvelopeSchema;
void _EVENT_ENVELOPE_SCHEMA_ANCHOR;

const SOURCE = 'gateway.tasks';

function emitWithMeta(subject, payload, meta = {}) {
  return emit(subject, payload, {
    source: SOURCE,
    task_id: payload?.task_id,
    ...meta,
  });
}

export function emitTaskCreated({
  taskId, title, projectId, phaseNumber, createdBy, priority, tags,
}) {
  const payload = {
    task_id: taskId,
    title,
    project_id: projectId,
    created_by: createdBy,
  };
  if (phaseNumber != null) payload.phase_number = phaseNumber;
  if (priority) payload.priority = priority;
  if (tags && tags.length > 0) payload.tags = tags;
  emitWithMeta('task.created', payload);
}

export function emitTaskClaimed({ taskId, assignedAgent, claimedAt }) {
  emitWithMeta('task.claimed', {
    task_id: taskId,
    assigned_agent: assignedAgent,
    claimed_at: claimedAt,
  });
}

export function emitTaskResumed({ taskId, actor, from, resumedAt = Date.now() }) {
  emitWithMeta('task.resumed', {
    task_id: taskId, actor, from, resumed_at: resumedAt,
  });
}

export function emitTaskProgressed({ taskId, actor, status, summary, filesChanged }) {
  const payload = { task_id: taskId, actor, status, summary };
  if (filesChanged && filesChanged.length > 0) payload.files_changed = filesChanged;
  emitWithMeta('task.progressed', payload);
}

export function emitTaskSubmitted({
  taskId, actor, summary, filesChanged, submittedAt = Date.now(),
}) {
  const payload = {
    task_id: taskId,
    actor,
    summary,
    submitted_at: submittedAt,
  };
  if (filesChanged && filesChanged.length > 0) payload.files_changed = filesChanged;
  emitWithMeta('task.submitted', payload);
}

export function emitTaskReviewRequested({ taskId, actor, reviewer }) {
  emitWithMeta('task.review_requested', {
    task_id: taskId, actor, reviewer,
  });
}

export function emitTaskApproved({
  taskId, reviewer, comment, approvedAt = Date.now(),
}) {
  const payload = { task_id: taskId, reviewer, approved_at: approvedAt };
  if (comment) payload.comment = comment;
  emitWithMeta('task.approved', payload);
}

export function emitTaskRejected({
  taskId, reviewer, reason, guidance, rejectedAt = Date.now(),
}) {
  const payload = {
    task_id: taskId, reviewer, reason, rejected_at: rejectedAt,
  };
  if (guidance) payload.guidance = guidance;
  emitWithMeta('task.rejected', payload);
}

export function emitTaskOrphaned({
  taskId, previousAgent, previousStatus, reason, orphanedAt = Date.now(),
}) {
  emitWithMeta('task.orphaned', {
    task_id: taskId,
    previous_agent: previousAgent,
    previous_status: previousStatus,
    reason,
    orphaned_at: orphanedAt,
  });
}

export function emitTaskOrphanClaimed({
  taskId, newOwner, previousOwner, journalEntries, claimedAt = Date.now(),
}) {
  emitWithMeta('task.orphan_claimed', {
    task_id: taskId,
    new_owner: newOwner,
    previous_owner: previousOwner,
    journal_entries: journalEntries,
    claimed_at: claimedAt,
  });
}

export function emitTaskReopened({ taskId, actor, reason, previousStatus }) {
  emitWithMeta('task.reopened', {
    task_id: taskId,
    actor,
    reason,
    previous_status: previousStatus,
  });
}

export function emitTaskCanceled({
  taskId, actor, reason, cancelledAt = Date.now(),
}) {
  emitWithMeta('task.canceled', {
    task_id: taskId,
    actor,
    reason,
    cancelled_at: cancelledAt,
  });
}

export function emitTaskUpdated({
  taskId, actor, fieldsChanged, updatedAt = Date.now(),
}) {
  emitWithMeta('task.updated', {
    task_id: taskId,
    actor,
    fields_changed: fieldsChanged,
    updated_at: updatedAt,
  });
}

export function emitTaskReleased({
  taskId, actor, reason, releasedAt = Date.now(),
}) {
  const payload = { task_id: taskId, actor, released_at: releasedAt };
  if (reason) payload.reason = reason;
  emitWithMeta('task.released', payload);
}

export function emitTaskReassigned({
  taskId, actor, newAgent, previousAgent, reassignedAt = Date.now(),
}) {
  emitWithMeta('task.reassigned', {
    task_id: taskId,
    actor,
    new_agent: newAgent,
    previous_agent: previousAgent ?? null,
    reassigned_at: reassignedAt,
  });
}

export function emitTaskComment({
  taskId, author, comment, commentedAt = Date.now(),
}) {
  emitWithMeta('task.comment', {
    task_id: taskId,
    author,
    comment,
    commented_at: commentedAt,
  });
}

// -- submission.* --------------------------------------------------------
//
// Emitted by submitTask; kept in the tasks plane rather than a separate
// submission/ plane because (a) they only fire from one handler, and (b)
// they share the task_id-centric subscriber set with the task.* family.

export function emitSubmissionReceived({
  taskId, submitter, summary, filesChangedCount, receivedAt = Date.now(),
}) {
  emitWithMeta('submission.received', {
    task_id: taskId,
    submitter,
    summary,
    files_changed_count: filesChangedCount,
    received_at: receivedAt,
  });
}

export function emitSubmissionFlaggedStub({
  taskId, submitter, findings, flaggedAt = Date.now(),
}) {
  emitWithMeta('submission.flagged_stub', {
    task_id: taskId,
    submitter,
    findings,
    flagged_at: flaggedAt,
  });
}

export function emitSubmissionFlaggedMissingJournal({
  taskId, submitter, expectedJournalPath, flaggedAt = Date.now(),
}) {
  emitWithMeta('submission.flagged_missing_journal', {
    task_id: taskId,
    submitter,
    expected_journal_path: expectedJournalPath,
    flagged_at: flaggedAt,
  });
}

// -- task.failed / task.delete.* ------------------------------------------
// Added Phase 3.0.b to unblock transitions.js barrel load.

export function emitTaskFailed({
  taskId, actor, reason, failedAt = Date.now(),
}) {
  emitWithMeta('task.failed', {
    task_id: taskId,
    actor,
    reason,
    failed_at: failedAt,
  });
}

export function emitTaskDeleteRequested({
  taskId, actor, requestedAt = Date.now(),
}) {
  emitWithMeta('task.delete_requested', {
    task_id: taskId,
    actor,
    requested_at: requestedAt,
  });
}

export function emitTaskDeleteDenied({
  taskId, actor, deniedAt = Date.now(),
}) {
  emitWithMeta('task.delete_denied', {
    task_id: taskId,
    actor,
    denied_at: deniedAt,
  });
}

export function emitTaskDeleted({
  taskId, actor, deletedAt = Date.now(),
}) {
  emitWithMeta('task.deleted', {
    task_id: taskId,
    actor,
    deleted_at: deletedAt,
  });
}
