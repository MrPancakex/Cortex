/**
 * verification.* event payload schemas. Reviewer decision lifecycle:
 *   requested → passed | failed
 *
 * `decision_at` uses ISO datetime (z.string().datetime()) to match the
 * spec. This diverges from the epoch-ms integer convention in task.js and
 * session.js — flagged for future normalisation in the review plane work.
 */
import { z } from 'zod';
import { AgentIdSchema, TaskIdSchema } from '../_primitives.js';

const ProjectIdSchema = z.string().min(1);
const IsoDateSchema = z.string().datetime();

export const VerificationRequestedSchema = z.object({
  task_id: TaskIdSchema,
  project_id: ProjectIdSchema,
  // `reviewer_agent` is nullable — a verification request may be posted
  // before a reviewer has been assigned.
  reviewer_agent: AgentIdSchema.nullable(),
  // `summary` is nullable — the requester may omit a human-readable summary.
  summary: z.string().nullable(),
}).strict();

export const VerificationPassedSchema = z.object({
  task_id: TaskIdSchema,
  project_id: ProjectIdSchema,
  reviewer_agent: AgentIdSchema,
  decision_at: IsoDateSchema,
}).strict();

export const VerificationFailedSchema = z.object({
  task_id: TaskIdSchema,
  project_id: ProjectIdSchema,
  reviewer_agent: AgentIdSchema,
  reason: z.string().min(1),
  decision_at: IsoDateSchema,
}).strict();

export const VerificationEventPayloadMap = {
  'verification.requested': VerificationRequestedSchema,
  'verification.passed': VerificationPassedSchema,
  'verification.failed': VerificationFailedSchema,
};
