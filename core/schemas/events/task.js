/**
 * task.* event payload schemas. Covers the full task state machine:
 * created → claimed → in_progress → submitted → review → approved|rejected|…
 *
 * Shapes mirror the rows emitted by gateway/tasks (Phase 5) so a subscriber
 * reading the events stream sees the same field set it would get from the
 * DB. Actor fields (created_by, assigned_agent, reviewer) are always agent
 * identifiers — never tokens or hashes.
 */
import { z } from 'zod';
import { AgentIdSchema, TaskIdSchema } from '../_primitives.js';

export const TaskCreatedEventSchema = z.object({
  task_id: TaskIdSchema,
  title: z.string().min(1),
  project_id: z.string().min(1),
  phase_number: z.number().int().positive().optional(),
  created_by: AgentIdSchema,
  priority: z.enum(['low', 'medium', 'normal', 'high', 'critical']).optional(),
  tags: z.array(z.string()).optional(),
});

export const TaskClaimedEventSchema = z.object({
  task_id: TaskIdSchema,
  assigned_agent: AgentIdSchema,
  claimed_at: z.number().int().nonnegative(),
});

export const TaskProgressedEventSchema = z.object({
  task_id: TaskIdSchema,
  actor: AgentIdSchema,
  status: z.enum(['planning', 'implementation', 'in_progress', 'testing', 'reviewing']),
  summary: z.string().min(1),
  files_changed: z.array(z.string()).optional(),
});

export const TaskSubmittedEventSchema = z.object({
  task_id: TaskIdSchema,
  actor: AgentIdSchema,
  summary: z.string().min(1),
  files_changed: z.array(z.string()).optional(),
  submitted_at: z.number().int().nonnegative(),
});

export const TaskReviewRequestedEventSchema = z.object({
  task_id: TaskIdSchema,
  actor: AgentIdSchema,
  reviewer: AgentIdSchema,
});

// Reservation note (ultrareview lens 3): `task.reviewed` has no producer
// as of Phase 11 — approveTask/rejectTask emit `task.approved`/
// `task.rejected` directly. Consumers looking for the general "reviewer
// decided" signal should subscribe to both terminal subjects (or to
// `review.verdict` once the review plane ships). The schema stays in
// the taxonomy because the spec lock test asserts it; drop-or-wire is
// tracked for the review plane work.
export const TaskReviewedEventSchema = z.object({
  task_id: TaskIdSchema,
  reviewer: AgentIdSchema,
  verdict: z.enum(['approved', 'changes_required', 'rejected']),
  comment: z.string().optional(),
});

export const TaskApprovedEventSchema = z.object({
  task_id: TaskIdSchema,
  reviewer: AgentIdSchema,
  comment: z.string().optional(),
  approved_at: z.number().int().nonnegative(),
});

// Note: task.rejected carries only the task-level reason/guidance that
// triggered the state change. The richer review context (verdict, full
// comment, duration) is emitted separately as review.verdict and linked
// via review_id → task_id.
//
// Consumer guidance: subscribe to EITHER `task.rejected` (task-state
// events, one per state change) OR `review.verdict` filtered by
// `verdict === 'rejected'` (review-lifecycle events), NEVER both, or a
// rejection will double-count in rate/latency dashboards.
export const TaskRejectedEventSchema = z.object({
  task_id: TaskIdSchema,
  reviewer: AgentIdSchema,
  reason: z.string().min(1),
  guidance: z.string().optional(),
  review_id: z.string().uuid().optional(),
  rejected_at: z.number().int().nonnegative(),
});

// `previous_agent` is nullable because an already-cleared row (e.g., a task
// re-orphaned after a reassign nulled the owner) still has a legitimate
// orphan transition — the payload records the event even with no owner to
// name.
export const TaskOrphanedEventSchema = z.object({
  task_id: TaskIdSchema,
  previous_agent: AgentIdSchema.nullable(),
  previous_status: z.enum(['pending', 'claimed', 'in_progress', 'submitted', 'review']),
  reason: z.enum(['agent_stale', 'session_expired', 'force_release', 'cancel']),
  orphaned_at: z.number().int().nonnegative(),
});

// Phase 5 — claiming an orphaned task is a distinct lifecycle event from a
// normal claim because (a) the journal is inherited, and (b) the task
// short-circuits from `orphaned` → `in_progress` (skipping `claimed`). The
// dashboard's handoff UI filters on this subject.
export const TaskOrphanClaimedEventSchema = z.object({
  task_id: TaskIdSchema,
  new_owner: AgentIdSchema,
  previous_owner: AgentIdSchema.nullable(),
  journal_entries: z.number().int().nonnegative(),
  claimed_at: z.number().int().nonnegative(),
});

export const TaskReopenedEventSchema = z.object({
  task_id: TaskIdSchema,
  actor: AgentIdSchema,
  reason: z.string().min(1),
  previous_status: z.enum(['approved', 'rejected', 'cancelled']),
});

export const TaskCanceledEventSchema = z.object({
  task_id: TaskIdSchema,
  actor: AgentIdSchema,
  reason: z.string().min(1),
  cancelled_at: z.number().int().nonnegative(),
});

// Phase 5 — emitted by state-machine.resumeTask when a claimed or rejected
// task is re-advanced to in_progress by its owner.
export const TaskResumedEventSchema = z.object({
  task_id: TaskIdSchema,
  actor: AgentIdSchema,
  from: z.enum(['claimed', 'rejected']),
  resumed_at: z.number().int().nonnegative(),
});

// Phase 5 — metadata-only update (title/description/priority/tags). Never
// carries the new field values to avoid replicating the row via the event
// bus; subscribers re-read the task if they need the full shape.
export const TaskUpdatedEventSchema = z.object({
  task_id: TaskIdSchema,
  actor: AgentIdSchema,
  updated_at: z.number().int().nonnegative(),
  fields_changed: z.array(z.enum(['title', 'description', 'priority', 'tags'])),
});

// Phase 5 — owner / admin drops the task back into the pending pool.
export const TaskReleasedEventSchema = z.object({
  task_id: TaskIdSchema,
  actor: AgentIdSchema,
  reason: z.string().optional(),
  released_at: z.number().int().nonnegative(),
});

// Phase 5 — admin reassigns ownership. `previous_agent` is nullable because
// admins can reassign a never-claimed task.
export const TaskReassignedEventSchema = z.object({
  task_id: TaskIdSchema,
  actor: AgentIdSchema,
  new_agent: AgentIdSchema,
  previous_agent: AgentIdSchema.nullable(),
  reassigned_at: z.number().int().nonnegative(),
});

// Phase 5 — free-form comment on a task (status unchanged).
export const TaskCommentEventSchema = z.object({
  task_id: TaskIdSchema,
  author: AgentIdSchema,
  comment: z.string().min(1),
  commented_at: z.number().int().nonnegative(),
});

export const TaskEventPayloadMap = {
  'task.created': TaskCreatedEventSchema,
  'task.claimed': TaskClaimedEventSchema,
  'task.resumed': TaskResumedEventSchema,
  'task.progressed': TaskProgressedEventSchema,
  'task.submitted': TaskSubmittedEventSchema,
  'task.review_requested': TaskReviewRequestedEventSchema,
  'task.reviewed': TaskReviewedEventSchema,
  'task.approved': TaskApprovedEventSchema,
  'task.rejected': TaskRejectedEventSchema,
  'task.orphaned': TaskOrphanedEventSchema,
  'task.orphan_claimed': TaskOrphanClaimedEventSchema,
  'task.reopened': TaskReopenedEventSchema,
  'task.canceled': TaskCanceledEventSchema,
  'task.updated': TaskUpdatedEventSchema,
  'task.released': TaskReleasedEventSchema,
  'task.reassigned': TaskReassignedEventSchema,
  'task.comment': TaskCommentEventSchema,
};
