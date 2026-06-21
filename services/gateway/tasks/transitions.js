/**
 * Task state-machine — write paths (Phase 3.0.b extraction).
 *
 * The 14 mutating transitions from the former state-machine.js: create,
 * claim, resume, reportProgress, submit, requestVerification, approve,
 * reject, update, cancel, release, reassign, comment, reopen. Each:
 *   1. Validates body via safeParse on a core/schemas zod schema,
 *   2. Authorises the actor (owner / reviewer / admin),
 *   3. Runs a single UPDATE with a status guard (WHERE status = 'X'),
 *   4. Writes an audit/progress/journal/comment row inside the same txn
 *      where useful,
 *   5. Emits a typed task.* / submission.* event AFTER commit,
 *   6. Returns `{ status, body }` — the routes module maps to HTTP.
 *
 * Journal enforcement: submitTask + requestVerification call
 * checkJournalCompleteness() BEFORE the DB write.
 *
 * Pure extraction — logic byte-identical to the original. Shared helpers
 * live in _internals.js; state-machine.js re-exports these unchanged.
 */
import { randomUUID } from 'node:crypto';
import {
  TaskCreateSchema,
  TaskUpdateSchema,
  TaskCancelSchema,
  TaskReleaseSchema,
  TaskReassignSchema,
  TaskReopenSchema,
  TaskCommentSchema,
  TaskFailSchema,
  SubmitResultSchemaV2,
  RequestVerificationSchemaV2,
  ProgressReportSchema,
} from '@cortex/core/schemas';
import { swallow } from '@cortex/sdk/errors';
import { getDb } from '@cortex/sdk/db';
import { getTaskStatements } from './statements.js';
import { serializeTaskDetail } from './serialize.js';
import { checkJournalCompleteness } from './journal.js';
import {
  renameOnApprove,
  renameOnRejectOrReopen,
} from './lifecycle.js';
import {
  emitTaskCreated,
  emitTaskClaimed,
  emitTaskResumed,
  emitTaskProgressed,
  emitTaskSubmitted,
  emitTaskReviewRequested,
  emitTaskApproved,
  emitTaskRejected,
  emitTaskReopened,
  emitTaskCanceled,
  emitTaskUpdated,
  emitTaskReleased,
  emitTaskReassigned,
  emitTaskComment,
  emitTaskFailed,
  emitSubmissionReceived,
  emitSubmissionFlaggedStub,
  emitSubmissionFlaggedMissingJournal,
} from './events.js';
import {
  ok,
  created,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  hint,
  sanitiseSummary,
  sameAgent,
  requireTask,
  syncFiles,
  actorOwnsTask,
  actorCreatedTask,
  actorReviewsTask,
  phaseIdForProject,
  resolveOrCreateTaskDir,
  removeCreatedTaskDir,
} from './_internals.js';
import { appendLedgerAndEvents } from './ledger.js';
import { getProjectDir } from './folders.js';
import { dualWrite, dualWriteNoGuard } from './_dualwrite.js';

/**
 * Returns the agent id allowed to force-release a task from `review` status
 * (in addition to isAdmin). Configurable via CORTEX_FORCE_RELEASE_AGENT env
 * var so operators can wire their own reviewer agent without hardcoding a name.
 * Read lazily at call time so tests can set the env var after module import.
 * Returns '' (empty) by default — only isAdmin can force-release unless configured.
 */
function getForceReleaseAgent() {
  return process.env.CORTEX_FORCE_RELEASE_AGENT || '';
}
export {
  requestTaskDelete,
  approveTaskDelete,
  denyTaskDelete,
  approveAllTaskDeletes,
  denyAllTaskDeletes,
} from './delete.js';

// -- 1. create -------------------------------------------------------------

export function createTask({ body, actor, isAdmin = false }) {
  const parsed = TaskCreateSchema.safeParse(body);
  if (!parsed.success) return badRequest('invalid_body', { issues: parsed.error.issues });
  const stmts = getTaskStatements();
  const project = stmts.getProject.get(parsed.data.project_id);
  if (!project) return { status: 404, body: { error: 'project_not_found' } };
  const title = sanitiseSummary(parsed.data.title, 200, { multiline: false });
  if (!title) return badRequest('title_required');
  const description = parsed.data.description
    ? sanitiseSummary(parsed.data.description, 5000)
    : '';
  const priority = parsed.data.priority || 'medium';
  const tagsJson = JSON.stringify(Array.isArray(parsed.data.tags)
    ? parsed.data.tags.slice(0, 16).map((t) => String(t).slice(0, 100)) : []);
  const createdBy = actor?.id || (isAdmin ? 'admin' : 'system');
  const phaseId = phaseIdForProject(parsed.data.project_id, parsed.data.phase_number);
  const id = randomUUID();
  // section is included only when the caller provided one — sqlite
  // storage hygiene (smaller blob, no spurious key in `meta` walks)
  // and serializer-shape parity with pre-section tasks.
  const metaPayload = {
    source: isAdmin ? 'human' : 'agent',
    phase_number: parsed.data.phase_number || 1,
  };
  if (parsed.data.section) metaPayload.section = parsed.data.section;
  const metadata = JSON.stringify(metaPayload);

  // Wrap INSERT + audit_log + ledger.jsonl in one transaction (C3 dual-write).
  // createTask has no WHERE status guard — the row is new — so we use a
  // stub taskRow with status=null and to_status='pending'.
  // Task 120 (genesis atomicity, carved from 1b): the per-task folder is
  // created BEFORE the transaction (with a discoverable README placeholder)
  // and the genesis task_created line lands in BOTH the per-project
  // ledger.jsonl AND the task's own events.jsonl inside the transaction via
  // the compensated dual append — so the events.jsonl genesis line commits in
  // lockstep with the row/audit/ledger or none of them land. A failure after
  // folder creation removes the folder (zero residue).
  try {
    const db = getDb();
    const projectForLedger = stmts.getProject.get(parsed.data.project_id);
    const projectDir = getProjectDir(projectForLedger);
    if (!projectDir) throw new Error('project_dir_unknown');
    const genesisStub = {
      id,
      project_id: parsed.data.project_id,
      phase_id: phaseId,
      phase_number: parsed.data.phase_number || 1,
      title,
      status: 'pending',
    };
    const resolved = resolveOrCreateTaskDir(projectForLedger, genesisStub);
    const ts = new Date().toISOString();
    const auditPayload = JSON.stringify({
      title, priority, created_by: createdBy,
      phase_number: parsed.data.phase_number || 1,
    });
    const genesisLine = {
      ts,
      task_id: id,
      project_id: parsed.data.project_id,
      actor: createdBy,
      event_type: 'task_created',
      from_status: null,
      to_status: 'pending',
      data: { title, priority, created_by: createdBy, phase_number: parsed.data.phase_number || 1 },
    };
    // R4: undo handle captured outside the txn closure.
    let genesisAppendUndo = null;
    try {
      db.transaction(() => {
        stmts.createTask.run(
          id,
          parsed.data.project_id,
          phaseId,
          title,
          description,
          priority,
          null,      // assigned_to — always null at creation
          createdBy,
          tagsJson,
          metadata,
        );
        stmts.insertAudit.run(
          randomUUID(), id, parsed.data.project_id,
          createdBy, 'task_created', auditPayload,
        );
        // Compensated dual append — genesis line in ledger.jsonl + events.jsonl
        // lands with the commit or is fully undone with the rollback.
        genesisAppendUndo = appendLedgerAndEvents(
          projectDir, resolved.taskDir, genesisLine,
        ).undo;
      })();
    } catch (err) {
      let compensationErr = null;
      try { if (genesisAppendUndo) genesisAppendUndo(); }
      catch (restoreErr) { compensationErr = restoreErr; }
      removeCreatedTaskDir(resolved);
      if (compensationErr) throw compensationErr;
      throw err;
    }
  } catch (err) {
    swallow('tasks.create_failed', err);
    return { status: 500, body: { error: 'create_failed', message: err.message } };
  }
  const row = stmts.getTask.get(id);
  const fileSync = syncFiles(id);
  try {
    emitTaskCreated({
      taskId: id,
      title,
      projectId: parsed.data.project_id,
      phaseNumber: parsed.data.phase_number,
      createdBy,
      priority,
      tags: parsed.data.tags || [],
    });
  } catch (err) {
    swallow('tasks.created_emit_failed', err);
  }
  return created({
    ...serializeTaskDetail(row),
    file_sync: fileSync,
    ...hint('Task created. Call claim_task to start, or task_list to verify it appeared.'),
  });
}

// -- 5. claimTask ----------------------------------------------------------

export function claimTask({ taskId, actor }) {
  if (!actor?.id) return unauthorized();
  const stmts = getTaskStatements();
  // FK pre-check — tasks.assigned_to → agents(id). Surface a clear
  // 400 'unknown_agent' instead of a bare SQLITE_CONSTRAINT_FOREIGNKEY so
  // a misconfigured bot sees the root cause immediately.
  if (!stmts.getAgentById.get(actor.id)) {
    return { status: 400, body: {
      error: 'unknown_agent',
      agent_id: actor.id,
      hint: 'register the agent (POST /v1/api/agents) before claiming tasks',
    } };
  }
  const peekForClaim = stmts.getTask.get(taskId);
  if (!peekForClaim) return notFound();
  try {
    dualWrite({
      taskRow: peekForClaim,
      eventType: 'task_claimed',
      toStatus: 'claimed',
      actor: actor.id,
      data: { assigned_to: actor.id },
      mutateStmt: stmts.claimTask,
      mutateParams: [actor.id, taskId],
    });
  } catch (err) {
    if (err.message === 'state_guard_failed') {
      const peek = stmts.getTask.get(taskId);
      if (!peek) return notFound();
      return conflict('not_claimable', { current_status: peek.status });
    }
    swallow('tasks.claim_dualwrite_failed', err);
    return { status: 500, body: { error: 'claim_failed', message: err.message } };
  }
  const task = stmts.getTask.get(taskId);
  const fileSync = syncFiles(taskId);
  try {
    emitTaskClaimed({
      taskId,
      assignedAgent: actor.id,
      claimedAt: Date.now(),
    });
  } catch (err) {
    swallow('tasks.claimed_emit_failed', err);
  }
  return ok({
    id: task.id,
    title: task.title,
    status: task.status,
    assigned_to: task.assigned_to,
    claimed_at: task.claimed_at,
    file_sync: fileSync,
    ...hint("Task claimed. Call report_progress with status='planning' BEFORE writing code."),
  });
}

// -- 6. resumeTask ---------------------------------------------------------

export function resumeTask({ taskId, actor, isAdmin = false }) {
  if (!actor?.id) return unauthorized();
  const r = requireTask(taskId);
  if (r.status) return { status: r.status, body: r.body };
  const task = r.task;
  if (task.status === 'pending') return claimTask({ taskId, actor });
  if (task.status === 'orphaned') {
    return conflict('task_orphaned', {
      hint: 'call claim_orphan, not resume',
    });
  }
  if (['approved', 'cancelled', 'failed'].includes(task.status)) {
    return conflict('terminal_status', { status: task.status });
  }
  if (['submitted', 'review'].includes(task.status)) {
    return conflict('in_flight', { status: task.status });
  }
  const owner = actorOwnsTask(task, actor);
  if (!owner && !isAdmin) return forbidden('not_owner');
  const stmts = getTaskStatements();
  if (task.status === 'claimed') {
    try {
      dualWrite({
        taskRow: task,
        eventType: 'task_resumed',
        toStatus: 'in_progress',
        actor: actor.id,
        data: { from: 'claimed' },
        mutateStmt: stmts.resumeFromClaim,
        mutateParams: [taskId],
      });
    } catch (err) {
      if (err.message === 'state_guard_failed') return conflict('state_changed_concurrently');
      swallow('tasks.resume_dualwrite_failed', err);
      return { status: 500, body: { error: 'resume_failed', message: err.message } };
    }
    // Phase 1b rework (BUG B): resume bumps fs_version + changes status, so
    // task.json must be re-rendered after commit (DB fs_version == task.json
    // fs_version post-transition). Side-effect only — response shape unchanged.
    syncFiles(taskId);
    try { emitTaskResumed({ taskId, actor: actor.id, from: 'claimed' }); }
    catch (err) { swallow('tasks.resumed_emit_failed', err); }
    return ok({ id: task.id, status: 'in_progress', ...hint('Task in_progress.') });
  }
  if (task.status === 'rejected') {
    try {
      dualWrite({
        taskRow: task,
        eventType: 'task_resumed',
        toStatus: 'in_progress',
        actor: actor.id,
        data: { from: 'rejected' },
        mutateStmt: stmts.resumeFromReject,
        mutateParams: [taskId],
      });
    } catch (err) {
      if (err.message === 'state_guard_failed') return conflict('state_changed_concurrently');
      swallow('tasks.resume_dualwrite_failed', err);
      return { status: 500, body: { error: 'resume_failed', message: err.message } };
    }
    // Phase 1b rework (BUG B): re-render task.json after the bump (see above).
    syncFiles(taskId);
    try { emitTaskResumed({ taskId, actor: actor.id, from: 'rejected' }); }
    catch (err) { swallow('tasks.resumed_emit_failed', err); }
    return ok({ id: task.id, status: 'in_progress', ...hint('Task back in_progress.') });
  }
  if (task.status === 'in_progress') {
    return ok({ id: task.id, status: task.status, no_op: true });
  }
  return conflict('not_resumable', { status: task.status });
}

// -- 7. reportProgress -----------------------------------------------------

export function reportProgress({ taskId, body, actor }) {
  if (!actor?.id) return unauthorized();
  const stage = body?.status === 'implementation' ? 'in_progress' : body?.status;
  const parseProbe = ProgressReportSchema.safeParse({
    task_id: taskId,
    status: stage,
    summary: typeof body?.summary === 'string' ? body.summary : '',
    files_changed: Array.isArray(body?.files_changed) ? body.files_changed : undefined,
  });
  if (!parseProbe.success) {
    return badRequest('invalid_body', { issues: parseProbe.error.issues });
  }
  const summary = sanitiseSummary(body.summary, 2000);
  if (!summary) return badRequest('summary_required');
  const r = requireTask(taskId);
  if (r.status) return { status: r.status, body: r.body };
  const task = r.task;
  if (!actorOwnsTask(task, actor)) return forbidden('not_owner');
  const files = Array.isArray(body.files_changed)
    ? body.files_changed.slice(0, 1024).map(String)
    : [];
  if (stage === 'in_progress' && files.length === 0) {
    return conflict('in_progress_requires_files', {
      hint: 'include files_changed when reporting implementation progress',
    });
  }

  const stmts = getTaskStatements();
  const db = getDb();
  const metadataJson = JSON.stringify({
    files_changed: files,
    stub_detected: !!body.stub_detected,
  });
  const progressId = randomUUID();

  // Resolve project dir before entering the transaction (no I/O inside txn
  // other than the ledger append itself, which is the intentional last step).
  const progressProject = stmts.getProject.get(task.project_id);
  const progressProjectDir = getProjectDir(progressProject);
  // Task 120 (D4): the per-task folder is resolved-or-created right before
  // the transaction runs (create-or-fail-loud — never silently skipped).
  // Populated below, inside the same try as the transaction, so a folder
  // created for this transition is compensated when the transaction fails.
  let progressResolved = null;
  // from/to status for ledger — auto-advance changes claimed/rejected→in_progress
  const progressFromStatus = task.status;
  const progressToStatus = (task.status === 'claimed' || task.status === 'rejected')
    ? 'in_progress' : task.status;
  const progressTs = new Date().toISOString();
  const progressAuditPayload = JSON.stringify({
    title: task.title, stage, files_changed_count: files.length,
  });
  const progressLine = {
    ts: progressTs,
    task_id: taskId,
    project_id: task.project_id,
    actor: actor.id,
    event_type: 'task_progressed',
    from_status: progressFromStatus,
    to_status: progressToStatus,
    data: { title: task.title, stage, files_changed_count: files.length },
  };

  // R4: undo handle captured outside the txn closure so the
  // outer catch can invoke it on a post-append commit failure.
  let progressAppendUndo = null;
  const tx = db.transaction(() => {
    // Auto-advance from claimed→in_progress when the first implementation
    // progress lands. Resume-from-rejected also maps through here when
    // the owner reports progress on a rejected task.
    if (task.status === 'claimed') stmts.resumeFromClaim.run(taskId);
    if (task.status === 'rejected' && actorOwnsTask(task, actor)) {
      stmts.resumeFromReject.run(taskId);
    }
    stmts.insertProgress.run(
      progressId, taskId, actor.id, stage, 0, summary, metadataJson,
    );
    // Mirror planning / testing rows into the journal so
    // checkJournalCompleteness has structured evidence without the agent
    // needing to call /journal explicitly. in_progress + reviewing have
    // no journal equivalent — those types must be written explicitly.
    const progressToJournal = { planning: 'planning', testing: 'test' };
    const journalType = progressToJournal[stage];
    if (journalType) {
      const jid = randomUUID();
      stmts.insertTaskJournal.run(
        jid, taskId, journalType, summary,
        JSON.stringify(files), '{}', actor.id,
      );
    }
    // Phase 1b §4: bump fs_version (state may auto-advance claimed/rejected→
    // in_progress, and the progress row + journal mirror change task.json).
    stmts.bumpFsVersion.run(taskId);
    // C3 dual-write — audit_log + ledger LAST inside the transaction.
    if (progressProjectDir) {
      stmts.insertAudit.run(
        randomUUID(), taskId, task.project_id,
        actor.id, 'task_progressed', progressAuditPayload,
      );
      // Phase 1b rework (BUG A): compensated dual append — ledger.jsonl +
      // per-task events.jsonl land together or roll back together.
      // R4: assign to outer-scope variable so outer catch can undo on
      // post-append commit failure.
      progressAppendUndo = appendLedgerAndEvents(
        progressProjectDir, progressResolved.taskDir, progressLine,
      ).undo;
    }
  });
  try {
    if (progressProjectDir) progressResolved = resolveOrCreateTaskDir(progressProject, task);
    tx();
  } catch (err) {
    // Task 120: a folder created for this transition is removed when the
    // transaction fails — zero filesystem residue on rollback.
    // R4: also restore events.jsonl + ledger.jsonl when the append succeeded
    // but a later step (e.g. SQLite commit) threw.
    let compensationErr = null;
    try { if (progressAppendUndo) progressAppendUndo(); }
    catch (restoreErr) { compensationErr = restoreErr; }
    removeCreatedTaskDir(progressResolved);
    if (compensationErr) {
      swallow('tasks.progress_tx_failed', err);
      return { status: 500, body: { error: 'progress_failed', message: compensationErr.message } };
    }
    swallow('tasks.progress_tx_failed', err);
    return { status: 500, body: { error: 'progress_failed', message: err.message } };
  }

  const count = stmts.countProgressByTask.get(taskId)?.count || 0;
  const fileSync = syncFiles(taskId);
  try {
    emitTaskProgressed({
      taskId,
      actor: actor.id,
      status: stage,
      summary,
      filesChanged: files,
    });
  } catch (err) { swallow('tasks.progressed_emit_failed', err); }
  return ok({
    task_id: taskId,
    progress_count: count,
    status: stmts.getTask.get(taskId)?.status || 'in_progress',
    file_sync: fileSync,
    ...hint(stage === 'planning' ? 'Begin implementation.'
      : stage === 'in_progress' ? 'Keep reporting progress; include files_changed.'
      : stage === 'testing' ? 'Run tests, then submit_result.'
      : 'Document your review findings.'),
  });
}

// -- 8. submitTask ---------------------------------------------------------

export function submitTask({ taskId, body, actor }) {
  if (!actor?.id) return unauthorized();
  const parsed = SubmitResultSchemaV2.safeParse({ ...(body || {}), task_id: taskId });
  if (!parsed.success) {
    return badRequest('invalid_body', { issues: parsed.error.issues });
  }
  const summary = sanitiseSummary(parsed.data.summary, 5000);
  if (!summary) return badRequest('summary_required');
  const r = requireTask(taskId);
  if (r.status) return { status: r.status, body: r.body };
  const task = r.task;
  if (!actorOwnsTask(task, actor)) return forbidden('not_owner');
  if (task.status !== 'in_progress') {
    return conflict('not_in_progress', { status: task.status });
  }

  const files = Array.isArray(parsed.data.files_changed)
    ? parsed.data.files_changed : [];

  // Announce the submission attempt BEFORE validation so dashboards see
  // every submission — including ones that fail journal / stub guards.
  try {
    emitSubmissionReceived({
      taskId, submitter: actor.id, summary,
      filesChangedCount: files.length,
    });
  } catch (err) { swallow('tasks.submission_received_emit_failed', err); }

  // Journal enforcement — authoritative check.
  const completeness = checkJournalCompleteness(taskId);
  if (!completeness.complete) {
    try {
      emitSubmissionFlaggedMissingJournal({
        taskId,
        submitter: actor.id,
        expectedJournalPath: `/v1/api/tasks/${taskId}/journal`,
      });
    } catch (err) { swallow('tasks.missing_journal_emit_failed', err); }
    return conflict('journal_incomplete', {
      missing: completeness.missing,
      present: completeness.present,
      hint: 'append journal entries of types: ' + completeness.missing.join(', '),
    });
  }

  const stmts = getTaskStatements();
  const fileProgressCount = stmts.countProgressWithFiles.get(taskId)?.count || 0;
  if (fileProgressCount < 1) {
    return conflict('no_progress_with_files', {
      hint: 'submit_result requires at least one progress report with files_changed',
    });
  }
  const stubCount = stmts.countStubsByTask.get(taskId)?.count || 0;
  if (stubCount > 0 && !parsed.data.override_stub_check) {
    try {
      emitSubmissionFlaggedStub({
        taskId,
        submitter: actor.id,
        findings: [{
          code: 'STUB_DETECTED',
          severity: 'error',
          message: `${stubCount} progress report(s) flagged stubs — resolve or override`,
        }],
      });
    } catch (err) { swallow('tasks.flagged_stub_emit_failed', err); }
    return conflict('stub_detected', { stub_count: stubCount });
  }

  try {
    dualWrite({
      taskRow: task,
      eventType: 'task_submitted',
      toStatus: 'submitted',
      actor: actor.id,
      data: { summary },
      mutateStmt: stmts.submitTask,
      mutateParams: [summary, taskId],
    });
  } catch (err) {
    if (err.message === 'state_guard_failed') return conflict('state_changed_concurrently');
    swallow('tasks.submit_dualwrite_failed', err);
    return { status: 500, body: { error: 'submit_failed', message: err.message } };
  }
  const updated = stmts.getTask.get(taskId);
  const fileSync = syncFiles(taskId);
  try {
    emitTaskSubmitted({
      taskId,
      actor: actor.id,
      summary,
      filesChanged: files,
      submittedAt: Date.now(),
    });
  } catch (err) { swallow('tasks.submitted_emit_failed', err); }
  return ok({
    task_id: taskId,
    status: updated.status,
    submitted_at: updated.submitted_at,
    file_sync: fileSync,
    ...hint('Submitted. Call request_verification with a reviewer to enter review.'),
  });
}

// -- 9. requestVerification ------------------------------------------------

export function requestVerification({ taskId, body, actor, isAdmin = false }) {
  if (!actor?.id) return unauthorized();
  const parsed = RequestVerificationSchemaV2.safeParse({ ...(body || {}), task_id: taskId });
  if (!parsed.success) {
    return badRequest('invalid_body', { issues: parsed.error.issues });
  }
  const r = requireTask(taskId);
  if (r.status) return { status: r.status, body: r.body };
  const task = r.task;
  if (task.status !== 'submitted') return conflict('not_submitted', { status: task.status });

  const reviewer = parsed.data.reviewer || parsed.data.reviewer_agent;
  if (!reviewer) return badRequest('reviewer_required');
  if (sameAgent(reviewer, actor.id) && actorOwnsTask(task, actor)) {
    return forbidden('cannot_review_own_work');
  }
  const reviewerPullingTask = sameAgent(reviewer, actor.id) && !actorOwnsTask(task, actor);
  if (!isAdmin && !actorOwnsTask(task, actor) && !reviewerPullingTask) {
    return forbidden('not_owner');
  }

  const completeness = checkJournalCompleteness(taskId, { strict: true });
  if (!completeness.complete) {
    return conflict('journal_incomplete_strict', {
      missing: completeness.missing,
      hint: 'append planning + context + decision + test entries before requesting verification',
    });
  }

  if (sameAgent(reviewer, actor.id) && actorOwnsTask(task, actor)) {
    return forbidden('cannot_review_own_work');
  }

  const stmts = getTaskStatements();
  try {
    dualWrite({
      taskRow: task,
      eventType: 'task_review_requested',
      toStatus: 'review',
      actor: actor.id,
      data: { reviewer },
      mutateStmt: stmts.verifyTask,
      mutateParams: [reviewer, taskId],
    });
  } catch (err) {
    if (err.message === 'state_guard_failed') return conflict('state_changed_concurrently');
    swallow('tasks.verify_dualwrite_failed', err);
    return { status: 500, body: { error: 'verify_failed', message: err.message } };
  }
  const fileSync = syncFiles(taskId);
  try {
    emitTaskReviewRequested({ taskId, actor: actor.id, reviewer });
  } catch (err) { swallow('tasks.review_requested_emit_failed', err); }
  return ok({
    task_id: taskId,
    status: 'review',
    reviewer_agent: reviewer,
    file_sync: fileSync,
    ...hint(`Task moved to review. Waiting on ${reviewer} to approve or reject.`),
  });
}

// -- 10. approveTask -------------------------------------------------------

export function approveTask({ taskId, body, actor, isAdmin = false }) {
  const r = requireTask(taskId);
  if (r.status) return { status: r.status, body: r.body };
  const task = r.task;
  if (task.status !== 'review') return conflict('not_in_review', { status: task.status });
  if (!isAdmin && !actorReviewsTask(task, actor)) return forbidden('not_reviewer');
  if (actorOwnsTask(task, actor)) return forbidden('cannot_review_own_work');
  const comment = sanitiseSummary(body?.comment, 2000);
  const stmts = getTaskStatements();
  const approveActor = actor?.id || 'admin';
  try {
    dualWrite({
      taskRow: task,
      eventType: 'task_approved',
      toStatus: 'approved',
      actor: approveActor,
      data: { reviewer: approveActor, comment: comment || null },
      mutateStmt: stmts.approveTask,
      mutateParams: [comment || null, taskId],
    });
  } catch (err) {
    if (err.message === 'state_guard_failed') return conflict('state_changed_concurrently');
    swallow('tasks.approve_dualwrite_failed', err);
    return { status: 500, body: { error: 'approve_failed', message: err.message } };
  }
  if (comment) {
    try {
      stmts.insertTaskComment.run(randomUUID(), taskId, approveActor, comment);
    } catch (err) { swallow('tasks.approve_comment_failed', err); }
  }
  const updated = stmts.getTask.get(taskId);
  let renameResult = null;
  try { renameResult = renameOnApprove({ taskId }); }
  catch (err) { swallow('tasks.rename_on_approve_failed', err); }
  const fileSync = syncFiles(taskId);
  try {
    emitTaskApproved({
      taskId,
      reviewer: actor?.id || 'admin',
      comment: comment || undefined,
    });
  } catch (err) { swallow('tasks.approved_emit_failed', err); }
  return ok({
    task_id: taskId,
    status: 'approved',
    approved_at: updated.approved_at,
    reviewer_agent: actor?.id || 'admin',
    comment: comment || null,
    file_sync: fileSync,
    folder_rename: renameResult,
    ...hint('Task approved. Work is complete.'),
  });
}

// -- 11. rejectTask --------------------------------------------------------

export function rejectTask({ taskId, body, actor, isAdmin = false }) {
  const reason = sanitiseSummary(body?.reason, 2000);
  if (!reason) return badRequest('reason_required');
  const guidance = sanitiseSummary(body?.guidance, 2000);
  const r = requireTask(taskId);
  if (r.status) return { status: r.status, body: r.body };
  const task = r.task;
  if (task.status !== 'review') return conflict('not_in_review', { status: task.status });
  if (!isAdmin && !actorReviewsTask(task, actor)) return forbidden('not_reviewer');
  if (actorOwnsTask(task, actor)) return forbidden('cannot_review_own_work');

  const stmts = getTaskStatements();
  const db = getDb();
  const rejectActor = actor?.id || 'admin';

  // Resolve project dir before entering the transaction.
  const rejectProject = stmts.getProject.get(task.project_id);
  const rejectProjectDir = getProjectDir(rejectProject);
  // Task 120 (D4): resolve-or-create the per-task folder (never skip).
  // Populated inside the same try as the transaction (compensated).
  let rejectResolved = null;
  // R4: undo handle captured outside txn closure.
  let rejectAppendUndo = null;
  const rejectTs = new Date().toISOString();
  const rejectAuditPayload = JSON.stringify({
    title: task.title, reviewer: rejectActor, reason, guidance: guidance || null,
  });
  const rejectLine = {
    ts: rejectTs,
    task_id: taskId,
    project_id: task.project_id,
    actor: rejectActor,
    event_type: 'task_rejected',
    from_status: 'review',
    to_status: 'rejected',
    data: { title: task.title, reviewer: rejectActor, reason, guidance: guidance || null },
  };

  const tx = db.transaction(() => {
    const info = stmts.rejectTask.run(reason, taskId);
    if (Number(info.changes) === 0) return { rejected: false };
    stmts.incrementRejectionCount.run(taskId);
    // Phase 1b §4: bump fs_version (the rejection changes task.json state).
    stmts.bumpFsVersion.run(taskId);
    try {
      stmts.insertTaskComment.run(
        randomUUID(), taskId, rejectActor,
        `[rejection] ${reason}${guidance ? `\n\nGuidance:\n${guidance}` : ''}`,
      );
    } catch (err) { swallow('tasks.reject_comment_failed', err); }
    // C3 dual-write — audit_log + ledger LAST inside the transaction.
    if (rejectProjectDir) {
      stmts.insertAudit.run(
        randomUUID(), taskId, task.project_id,
        rejectActor, 'task_rejected', rejectAuditPayload,
      );
      // Phase 1b rework (BUG A): compensated dual append — ledger.jsonl +
      // per-task events.jsonl land together or roll back together.
      // R4: capture undo handle.
      rejectAppendUndo = appendLedgerAndEvents(
        rejectProjectDir, rejectResolved.taskDir, rejectLine,
      ).undo;
    }
    return { rejected: true };
  });
  let result;
  try {
    if (rejectProjectDir) rejectResolved = resolveOrCreateTaskDir(rejectProject, task);
    result = tx();
  } catch (err) {
    let compensationErr = null;
    try { if (rejectAppendUndo) rejectAppendUndo(); }
    catch (restoreErr) { compensationErr = restoreErr; }
    removeCreatedTaskDir(rejectResolved);
    if (compensationErr) {
      swallow('tasks.reject_tx_failed', err);
      return { status: 500, body: { error: 'reject_failed', message: compensationErr.message } };
    }
    swallow('tasks.reject_tx_failed', err);
    return { status: 500, body: { error: 'reject_failed', message: err.message } };
  }
  if (!result.rejected) {
    // R3 (FIX 5): the zero-changes guard means the transaction did nothing —
    // but resolveOrCreateTaskDir may have already created the task folder for
    // this attempt. Compensate before returning 409 so no fs residue remains.
    removeCreatedTaskDir(rejectResolved);
    return conflict('state_changed_concurrently');
  }

  try { renameOnRejectOrReopen({ taskId }); }
  catch (err) { swallow('tasks.rename_on_reject_failed', err); }
  const fileSync = syncFiles(taskId);
  try {
    emitTaskRejected({
      taskId,
      reviewer: actor?.id || 'admin',
      reason,
      guidance: guidance || undefined,
    });
  } catch (err) { swallow('tasks.rejected_emit_failed', err); }
  return ok({
    task_id: taskId,
    status: 'rejected',
    reviewer_agent: actor?.id || 'admin',
    reason,
    guidance: guidance || null,
    file_sync: fileSync,
    ...hint('Task rejected. Call task_reopen with a reason to resume rework.'),
  });
}

// -- 12. updateTask --------------------------------------------------------

export function updateTask({ taskId, body, actor, isAdmin = false }) {
  const parsed = TaskUpdateSchema.safeParse(body || {});
  if (!parsed.success) return badRequest('invalid_body', { issues: parsed.error.issues });
  const r = requireTask(taskId);
  if (r.status) return { status: r.status, body: r.body };
  const task = r.task;
  if (!isAdmin && !actorOwnsTask(task, actor) && !actorCreatedTask(task, actor)) {
    return forbidden('not_owner_or_creator');
  }
  const title = parsed.data.title === undefined
    ? null : sanitiseSummary(parsed.data.title, 200, { multiline: false });
  const description = parsed.data.description === undefined
    ? null : sanitiseSummary(parsed.data.description, 5000);
  const priority = parsed.data.priority === undefined ? null : parsed.data.priority;
  const tags = parsed.data.tags === undefined ? null : JSON.stringify(parsed.data.tags);
  // Section is merged into the existing metadata JSON so updateTask
  // doesn't clobber `source`, `phase_number`, or any other downstream
  // fields. `undefined` means "don't touch"; `null` means "clear the
  // bucket so the dashboard falls back to General". Skip the rewrite
  // entirely when the new value equals the existing one — otherwise a
  // no-op PATCH would still bump `updated_at` and emit a `task.updated`
  // event claiming `section` changed, waking every subscriber for
  // nothing.
  let metadataJson = null;
  let sectionChanged = false;
  if (parsed.data.section !== undefined) {
    let meta = {};
    if (task.metadata) {
      try { meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : task.metadata; }
      catch (err) { void err; meta = {}; }
    }
    const previous = meta.section ?? null;
    const next = parsed.data.section ?? null;
    if (previous !== next) {
      if (next === null) delete meta.section;
      else meta.section = next;
      metadataJson = JSON.stringify(meta);
      sectionChanged = true;
    }
  }
  if (title == null && description == null && priority == null && tags == null && !sectionChanged) {
    return badRequest('no_fields_to_update');
  }
  const stmts = getTaskStatements();
  const updateActor = actor?.id || 'admin';
  const fieldsChanged = [];
  if (title != null) fieldsChanged.push('title');
  if (description != null) fieldsChanged.push('description');
  if (priority != null) fieldsChanged.push('priority');
  if (tags != null) fieldsChanged.push('tags');
  if (sectionChanged) fieldsChanged.push('section');
  try {
    dualWriteNoGuard({
      taskRow: task,
      eventType: 'task_updated',
      toStatus: task.status,
      actor: updateActor,
      data: { fields_changed: fieldsChanged },
      mutateFn: () => stmts.updateTask.run(title, description, priority, tags, metadataJson, taskId),
    });
  } catch (err) {
    swallow('tasks.update_dualwrite_failed', err);
    return { status: 500, body: { error: 'update_failed', message: err.message } };
  }
  // Phase 1b rework (BUG B): updateTask changes task.json-projected fields
  // (title / description / priority / tags / section) AND bumps fs_version via
  // dualWriteNoGuard, but previously returned without re-rendering task.json —
  // leaving the file with stale content + a stale fs_version while the DB
  // advanced, which corrupts the §4 version-gated FS-wins reconcile. Sync after
  // commit so DB fs_version == task.json fs_version and the projected fields
  // match on disk.
  syncFiles(taskId);
  const updated = stmts.getTask.get(taskId);
  try {
    emitTaskUpdated({
      taskId,
      actor: updateActor,
      fieldsChanged,
    });
  } catch (err) { swallow('tasks.updated_emit_failed', err); }
  return ok({
    id: taskId,
    title: updated.title,
    updated_at: updated.updated_at,
    fields_changed: fieldsChanged,
    ...hint('Task updated.'),
  });
}

// -- 13. cancelTask --------------------------------------------------------

export function cancelTask({ taskId, body, actor, isAdmin = false }) {
  const parsed = TaskCancelSchema.safeParse(body || {});
  if (!parsed.success) return badRequest('invalid_body', { issues: parsed.error.issues });
  const reason = sanitiseSummary(parsed.data.reason, 1000);
  if (!reason) return badRequest('reason_required');
  const r = requireTask(taskId);
  if (r.status) return { status: r.status, body: r.body };
  const task = r.task;
  if (!isAdmin && !actorOwnsTask(task, actor) && !actorCreatedTask(task, actor)) {
    return forbidden('not_owner_or_creator');
  }
  if (['approved', 'cancelled'].includes(task.status)) {
    return conflict('not_cancellable', { status: task.status });
  }
  const stmts = getTaskStatements();
  const cancelActor = actor?.id || 'admin';
  try {
    dualWrite({
      taskRow: task,
      eventType: 'task_cancelled',
      toStatus: 'cancelled',
      actor: cancelActor,
      data: { cancelled_by: cancelActor, reason },
      mutateStmt: stmts.cancelTask,
      mutateParams: [cancelActor, reason, taskId],
    });
  } catch (err) {
    if (err.message === 'state_guard_failed') return conflict('state_changed_concurrently');
    swallow('tasks.cancel_dualwrite_failed', err);
    return { status: 500, body: { error: 'cancel_failed', message: err.message } };
  }
  const fileSync = syncFiles(taskId);
  try {
    emitTaskCanceled({
      taskId,
      actor: cancelActor,
      reason,
    });
  } catch (err) { swallow('tasks.canceled_emit_failed', err); }
  return ok({
    task_id: taskId,
    status: 'cancelled',
    cancelled_by: actor?.id || 'admin',
    reason,
    file_sync: fileSync,
    ...hint('Task cancelled. Call get_next_task for more work.'),
  });
}

// -- 13b. failTask ---------------------------------------------------------
// V2 dashboard-backend restoration. `failed` was always in
// TaskStatusSchema; the cutover just never mounted the route the
// frontend's fail button calls. Mirrors cancelTask.

export function failTask({ taskId, body, actor, isAdmin = false }) {
  const parsed = TaskFailSchema.safeParse(body || {});
  if (!parsed.success) return badRequest('invalid_body', { issues: parsed.error.issues });
  const reason = sanitiseSummary(parsed.data.reason, 1000);
  if (!reason) return badRequest('reason_required');
  const r = requireTask(taskId);
  if (r.status) return { status: r.status, body: r.body };
  const task = r.task;
  if (!isAdmin && !actorOwnsTask(task, actor) && !actorCreatedTask(task, actor)) {
    return forbidden('not_owner_or_creator');
  }
  if (['approved', 'cancelled', 'failed'].includes(task.status)) {
    return conflict('not_failable', { status: task.status });
  }
  const stmts = getTaskStatements();
  const failActor = actor?.id || 'admin';
  try {
    dualWrite({
      taskRow: task,
      eventType: 'task_failed',
      toStatus: 'failed',
      actor: failActor,
      data: { failed_by: failActor, reason },
      mutateStmt: stmts.failTask,
      mutateParams: [failActor, reason, taskId],
    });
  } catch (err) {
    if (err.message === 'state_guard_failed') return conflict('state_changed_concurrently');
    swallow('tasks.fail_dualwrite_failed', err);
    return { status: 500, body: { error: 'fail_failed', message: err.message } };
  }
  const fileSync = syncFiles(taskId);
  try {
    emitTaskFailed({ taskId, actor: failActor, reason });
  } catch (err) { swallow('tasks.failed_emit_failed', err); }
  return ok({
    task_id: taskId,
    status: 'failed',
    failed_by: actor?.id || 'admin',
    reason,
    file_sync: fileSync,
    ...hint('Task failed. Call task_reopen with a reason to retry, or get_next_task.'),
  });
}

// -- 14. releaseTask -------------------------------------------------------

export function releaseTask({ taskId, body, actor, isAdmin = false }) {
  const parsed = TaskReleaseSchema.safeParse(body || {});
  if (!parsed.success) return badRequest('invalid_body', { issues: parsed.error.issues });
  const r = requireTask(taskId);
  if (r.status) return { status: r.status, body: r.body };
  const task = r.task;
  const forceReleaseAgent = getForceReleaseAgent();
  const forceReviewRelease = Boolean(
    parsed.data.force
      && task.status === 'review'
      && (isAdmin || (forceReleaseAgent && sameAgent(actor?.id, forceReleaseAgent))),
  );
  if (!['claimed', 'in_progress'].includes(task.status) && !forceReviewRelease) {
    return conflict('not_releasable', { status: task.status });
  }
  if (!forceReviewRelease && !isAdmin && !actorOwnsTask(task, actor)) return forbidden('not_owner');
  const stmts = getTaskStatements();
  const releaseActor = actor?.id || 'admin';
  try {
    dualWrite({
      taskRow: task,
      eventType: 'task_released',
      toStatus: 'pending',
      actor: releaseActor,
      data: { actor: releaseActor, reason: parsed.data.reason || null },
      mutateStmt: stmts.releaseTask,
      mutateParams: [taskId],
    });
  } catch (err) {
    if (err.message === 'state_guard_failed') return conflict('state_changed_concurrently');
    swallow('tasks.release_dualwrite_failed', err);
    return { status: 500, body: { error: 'release_failed', message: err.message } };
  }
  const fileSync = syncFiles(taskId);
  try {
    emitTaskReleased({
      taskId,
      actor: releaseActor,
      reason: parsed.data.reason || undefined,
    });
  } catch (err) { swallow('tasks.released_emit_failed', err); }
  return ok({
    task_id: taskId,
    status: 'pending',
    assigned_to: null,
    file_sync: fileSync,
    ...hint('Task released. Any agent can claim it.'),
  });
}

// -- 15. reassignTask ------------------------------------------------------

export function reassignTask({ taskId, body, actor, isAdmin = false }) {
  const parsed = TaskReassignSchema.safeParse(body || {});
  if (!parsed.success) return badRequest('invalid_body', { issues: parsed.error.issues });
  if (!isAdmin) return forbidden('admin_only');
  const newAgent = sanitiseSummary(
    parsed.data.new_agent || parsed.data.agent_id, 100, { multiline: false },
  );
  if (!newAgent) return badRequest('new_agent_required');
  const r = requireTask(taskId);
  if (r.status) return { status: r.status, body: r.body };
  const prior = r.task.assigned_to ?? null;
  const stmts = getTaskStatements();
  // FK pre-check — tasks.assigned_to → agents(id). A missing row would
  // otherwise surface as an opaque SQLITE_CONSTRAINT_FOREIGNKEY. Return a
  // clear 400 instead so the admin knows to register the agent first.
  if (!stmts.getAgentById.get(newAgent)) {
    return badRequest('unknown_agent', {
      agent_id: newAgent,
      hint: 'register the agent first (POST /v1/api/agents) before reassigning',
    });
  }
  const reassignActor = actor?.id || 'admin';
  const taskForReassign = r.task;
  try {
    dualWrite({
      taskRow: taskForReassign,
      eventType: 'task_reassigned',
      toStatus: 'pending',
      actor: reassignActor,
      data: { new_agent: newAgent, previous_agent: prior },
      mutateStmt: stmts.reassignTask,
      mutateParams: [newAgent, taskId],
    });
  } catch (err) {
    if (err.message === 'state_guard_failed') {
      return conflict('not_reassignable', { status: taskForReassign.status });
    }
    swallow('tasks.reassign_dualwrite_failed', err);
    return { status: 500, body: { error: 'reassign_failed', message: err.message } };
  }
  try {
    stmts.insertTaskComment.run(
      randomUUID(), taskId, reassignActor,
      `[system] Reassigned to ${newAgent}`,
    );
  } catch (err) { swallow('tasks.reassign_comment_failed', err); }
  const fileSync = syncFiles(taskId);
  try {
    emitTaskReassigned({
      taskId,
      actor: reassignActor,
      newAgent,
      previousAgent: prior,
    });
  } catch (err) { swallow('tasks.reassigned_emit_failed', err); }
  return ok({
    task_id: taskId,
    assigned_to: newAgent,
    status: 'pending',
    file_sync: fileSync,
    ...hint(`Reassigned to ${newAgent} as pending. They can now claim it.`),
  });
}

// -- 16. commentTask -------------------------------------------------------

export function commentTask({ taskId, body, actor }) {
  if (!actor?.id) return unauthorized();
  const parsed = TaskCommentSchema.safeParse(body || {});
  if (!parsed.success) return badRequest('invalid_body', { issues: parsed.error.issues });
  const comment = sanitiseSummary(parsed.data.comment, 2000);
  if (!comment) return badRequest('comment_required');
  const r = requireTask(taskId);
  if (r.status) return { status: r.status, body: r.body };
  const task = r.task;
  // Anyone visible to the task can comment (owner, creator, reviewer, admin).
  const allowed =
    actorOwnsTask(task, actor) ||
    actorCreatedTask(task, actor) ||
    actorReviewsTask(task, actor);
  if (!allowed) return forbidden('not_participant');
  const stmts = getTaskStatements();
  const commentId = randomUUID();
  let commentResolved;
  try {
    commentResolved = dualWriteNoGuard({
      taskRow: task,
      eventType: 'task_commented',
      toStatus: task.status,
      actor: actor.id,
      data: { author: actor.id, comment_length: comment.length },
      mutateFn: () => stmts.insertTaskComment.run(commentId, taskId, actor.id, comment),
      // Phase 1b rework (BUG B): a bare comment inserts a task_comments row but
      // changes NO task.json-projected tasks column (not even updated_at). Per
      // "append-only transitions that don't change the snapshot, prefer
      // NOT bumping" — bumping here without a matching task.json change would
      // push DB fs_version ahead of the file's, making the DB falsely "strictly
      // ahead" and causing the reconciler to skip legitimate later FS edits.
      // The audit row + the events.jsonl line are STILL written (parity), only
      // the fs_version bump is suppressed; commentTask therefore needs no sync
      // when the folder ALREADY exists.
      bumpVersion: false,
    });
  } catch (err) {
    swallow('tasks.comment_dualwrite_failed', err);
    return { status: 500, body: { error: 'comment_failed', message: err.message } };
  }
  // R3 (FIX 4): when dualWriteNoGuard just CREATED the folder (resolved.created),
  // the README placeholder is present but task.json is not — write the current DB
  // projection now. fs_version is NOT bumped (the comment changed no projected
  // tasks column, so DB and file agree on the pre-comment value).
  if (commentResolved?.created) {
    syncFiles(taskId);
  }
  try {
    emitTaskComment({
      taskId, author: actor.id, comment,
    });
  } catch (err) { swallow('tasks.comment_emit_failed', err); }
  return created({
    task_id: taskId,
    comment_id: commentId,
    author: actor.id,
    comment,
    ...hint('Comment added.'),
  });
}

// -- 17. reopenTask --------------------------------------------------------

export function reopenTask({ taskId, body, actor, isAdmin = false }) {
  const parsed = TaskReopenSchema.safeParse(body || {});
  if (!parsed.success) return badRequest('invalid_body', { issues: parsed.error.issues });
  const reason = sanitiseSummary(parsed.data.reason, 1000);
  if (!reason) return badRequest('reason_required');
  const r = requireTask(taskId);
  if (r.status) return { status: r.status, body: r.body };
  const task = r.task;
  if (!['approved', 'rejected'].includes(task.status)) {
    return conflict('not_reopenable', { status: task.status });
  }
  if (!isAdmin && !actorOwnsTask(task, actor) && !actorCreatedTask(task, actor)) {
    return forbidden('not_owner_or_creator');
  }
  const stmts = getTaskStatements();
  const reopenActor = actor?.id || 'admin';
  try {
    dualWrite({
      taskRow: task,
      eventType: 'task_reopened',
      toStatus: 'pending',
      actor: reopenActor,
      data: { previous_status: task.status, reason },
      mutateStmt: stmts.reopenTask,
      mutateParams: [taskId],
    });
  } catch (err) {
    if (err.message === 'state_guard_failed') return conflict('state_changed_concurrently');
    swallow('tasks.reopen_dualwrite_failed', err);
    return { status: 500, body: { error: 'reopen_failed', message: err.message } };
  }
  try { renameOnRejectOrReopen({ taskId }); }
  catch (err) { swallow('tasks.rename_on_reopen_failed', err); }
  try {
    stmts.insertTaskComment.run(
      randomUUID(), taskId, reopenActor,
      `[reopen] ${reason}`,
    );
  } catch (err) { swallow('tasks.reopen_comment_failed', err); }
  const fileSync = syncFiles(taskId);
  try {
    emitTaskReopened({
      taskId,
      actor: reopenActor,
      reason,
      previousStatus: task.status,
    });
  } catch (err) { swallow('tasks.reopened_emit_failed', err); }
  return ok({
    task_id: taskId,
    status: 'pending',
    assigned_to: null,
    reason,
    previous_status: task.status,
    file_sync: fileSync,
    ...hint('Reopened as pending. Call claim_task to rework.'),
  });
}
