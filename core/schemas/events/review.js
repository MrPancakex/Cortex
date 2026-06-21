/**
 * review.* event payload schemas. Code-review lifecycle on a task.
 *
 * Reservation note (ultrareview lens 3): as of Phase 11 none of these
 * subjects have producers in the gateway or the codex-reviewer plugin.
 * Consumers subscribing will see silence until the review pipeline is
 * wired (planned for the post-Phase-11 review plane). The schemas stay
 * in the spec §3.8 taxonomy — the spec-lock test in
 * `core/tests/events-schemas.test.js` exercises them — so the shape is
 * stable for when emitters land. Until then, treat subscription output
 * as "feature pending" rather than "event dropped silently".
 */
import { z } from 'zod';
import { AgentIdSchema, TaskIdSchema } from '../_primitives.js';

const ReviewIdSchema = z.string().uuid();

export const ReviewRequestedEventSchema = z.object({
  review_id: ReviewIdSchema,
  task_id: TaskIdSchema,
  requester: AgentIdSchema,
  reviewer: AgentIdSchema,
  requested_at: z.number().int().nonnegative(),
});

export const ReviewStartedEventSchema = z.object({
  review_id: ReviewIdSchema,
  task_id: TaskIdSchema,
  reviewer: AgentIdSchema,
  started_at: z.number().int().nonnegative(),
});

export const ReviewCompletedEventSchema = z.object({
  review_id: ReviewIdSchema,
  task_id: TaskIdSchema,
  reviewer: AgentIdSchema,
  duration_ms: z.number().int().nonnegative(),
  completed_at: z.number().int().nonnegative(),
});

export const ReviewVerdictEventSchema = z.object({
  review_id: ReviewIdSchema,
  task_id: TaskIdSchema,
  reviewer: AgentIdSchema,
  verdict: z.enum(['approved', 'changes_required', 'rejected']),
  comment: z.string().optional(),
  verdict_at: z.number().int().nonnegative(),
});

export const ReviewEventPayloadMap = {
  'review.requested': ReviewRequestedEventSchema,
  'review.started': ReviewStartedEventSchema,
  'review.completed': ReviewCompletedEventSchema,
  'review.verdict': ReviewVerdictEventSchema,
};
