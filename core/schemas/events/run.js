/**
 * run.* event payload schemas. Sub-agent run lifecycle:
 *   started → completed | failed | cancelled | budget_exceeded | reaped
 *
 * Shapes mirror the runs table rows emitted by the subagent plane (Phase 4-5).
 * Timestamps use epoch-ms integers to match the existing task/session
 * convention, EXCEPT swept_at_seconds which is epoch-seconds (named
 * accordingly — comes from the reaper sweep interval counter).
 */
import { z } from 'zod';
import { AgentIdSchema, TaskIdSchema } from '../_primitives.js';

const RunIdSchema = z.string().min(1);
const ProjectIdSchema = z.string().min(1);
const ProviderIdSchema = z.string().min(1);

const BudgetSchema = z.object({
  max_tokens: z.number().int().positive(),
  max_wall_seconds: z.number().int().positive(),
  max_tool_calls: z.number().int().positive(),
}).strict();

export const RunStartedSchema = z.object({
  run_id: RunIdSchema,
  task_id: TaskIdSchema,
  project_id: ProjectIdSchema,
  provider_id: ProviderIdSchema,
  model: z.string().min(1),
  parent_agent: AgentIdSchema,
  budget: BudgetSchema,
}).strict();

export const RunCompletedSchema = z.object({
  run_id: RunIdSchema,
  task_id: TaskIdSchema,
  project_id: ProjectIdSchema,
  provider_id: ProviderIdSchema,
  model: z.string().min(1),
  tokens_in: z.number().int().nonnegative(),
  tokens_out: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
  duration_ms: z.number().int().nonnegative(),
}).strict();

export const RunFailedSchema = z.object({
  run_id: RunIdSchema,
  task_id: TaskIdSchema,
  project_id: ProjectIdSchema,
  provider_id: ProviderIdSchema,
  model: z.string().min(1),
  exit_reason: z.string().min(1),
  duration_ms: z.number().int().nonnegative(),
}).strict();

export const RunCancelledSchema = z.object({
  run_id: RunIdSchema,
  task_id: TaskIdSchema,
  project_id: ProjectIdSchema,
  exit_reason: z.string().min(1),
}).strict();

export const RunBudgetExceededSchema = z.object({
  run_id: RunIdSchema,
  task_id: TaskIdSchema,
  project_id: ProjectIdSchema,
  budget: BudgetSchema,
  observed: z.object({
    tokens_consumed: z.number().int().nonnegative(),
    wall_seconds: z.number().int().nonnegative(),
    tool_calls: z.number().int().nonnegative(),
  }).strict(),
}).strict();

// `run.reaped` comes from the reaper sweep against the subagent_events table.
// A corresponding runs row may not exist (the subagent may have been spawned
// but never written a run), so task_id is optional. subagent_event_id mirrors
// subagent_events.id which is TEXT (not uuid-constrained at the DB level).
export const RunReapedSchema = z.object({
  subagent_event_id: z.string().min(1),
  parent_agent: AgentIdSchema,
  task_id: TaskIdSchema.optional(),
  swept_at_seconds: z.number().int().nonnegative(),
}).strict();

export const RunEventPayloadMap = {
  'run.started': RunStartedSchema,
  'run.completed': RunCompletedSchema,
  'run.failed': RunFailedSchema,
  'run.cancelled': RunCancelledSchema,
  'run.budget_exceeded': RunBudgetExceededSchema,
  'run.reaped': RunReapedSchema,
};
