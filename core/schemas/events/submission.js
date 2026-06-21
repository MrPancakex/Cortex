/**
 * submission.* event payload schemas. Submit-gate findings (stub detection,
 * missing journal, etc.) — distinct from review.* which is human-driven.
 */
import { z } from 'zod';
import { AgentIdSchema, TaskIdSchema } from '../_primitives.js';

/**
 * A single finding surfaced by the submit gate. `severity` maps to the
 * gate policy tiers; `code` is a stable identifier for dashboards.
 */
export const FindingSchema = z.object({
  code: z.string().regex(/^[A-Z0-9_]+$/),
  severity: z.enum(['info', 'warning', 'error', 'critical']),
  message: z.string().min(1),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
});

export const SubmissionReceivedEventSchema = z.object({
  task_id: TaskIdSchema,
  submitter: AgentIdSchema,
  summary: z.string().min(1),
  files_changed_count: z.number().int().nonnegative(),
  received_at: z.number().int().nonnegative(),
});

export const SubmissionFlaggedStubEventSchema = z.object({
  task_id: TaskIdSchema,
  submitter: AgentIdSchema,
  findings: z.array(FindingSchema).min(1),
  flagged_at: z.number().int().nonnegative(),
});

export const SubmissionFlaggedMissingJournalEventSchema = z.object({
  task_id: TaskIdSchema,
  submitter: AgentIdSchema,
  expected_journal_path: z.string().min(1),
  flagged_at: z.number().int().nonnegative(),
});

export const SubmissionEventPayloadMap = {
  'submission.received': SubmissionReceivedEventSchema,
  'submission.flagged_stub': SubmissionFlaggedStubEventSchema,
  'submission.flagged_missing_journal': SubmissionFlaggedMissingJournalEventSchema,
};
