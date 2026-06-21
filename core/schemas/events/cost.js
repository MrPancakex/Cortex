/**
 * cost.* event payload schemas. Model-spend telemetry — per-request
 * charges plus budget boundary crossings. Downstream: the cost plane's
 * aggregation views and budget alarms.
 */
import { z } from 'zod';
import { AgentIdSchema, LegacyTaskIdSchema } from '../_primitives.js';

// Upstream callers (legacy-prefixed task ids, header-sourced ids, CLI
// tooling) funnel into proxy/handler.js → emitCostCharged with a
// `taskId` that does not always pass strict UUID validation. Requiring
// `.uuid()` here previously caused emit() to reject the payload; the
// swallow at proxy/handler.js + streaming.js would silence the throw so
// the cost_entries row still persisted but the event bus saw nothing —
// dashboards subscribed to cost.charged drifted from the DB forever.
// Same defensive relaxation as BridgeSentEventSchema.task_id (bridge.js).
// Uses LegacyTaskIdSchema (min(1)) from _primitives — NOT TaskIdSchema (uuid).
const TaskIdSchema = LegacyTaskIdSchema;

export const CostChargedEventSchema = z.object({
  agent_id: AgentIdSchema,
  task_id: TaskIdSchema.optional(),
  model: z.string().min(1),
  provider: z.string().min(1),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  // Anthropic-style prompt caching produces distinct read/write token
  // classes that bill at different rates. Tri-state semantics consumers
  // MUST honor:
  //   absent (undefined)  → provider does not report prompt caching
  //                         (treat as N/A in "cached vs uncached" views)
  //   0                   → provider reports caching; this request
  //                         scored a cache miss
  //   positive integer    → cache hit of that many tokens
  // A bug that collapses undefined and 0 together (e.g. `?? 0`) breaks
  // cache-effectiveness dashboards; keep the distinction at emit sites.
  cache_read_tokens: z.number().int().nonnegative().optional(),
  cache_write_tokens: z.number().int().nonnegative().optional(),
  cost_usd: z.number().nonnegative(),
  charged_at: z.number().int().nonnegative(),
});

export const CostBudgetWarningEventSchema = z.object({
  scope: z.enum(['agent', 'project', 'global']),
  scope_id: z.string().min(1),
  budget_usd: z.number().positive(),
  spent_usd: z.number().nonnegative(),
  threshold_pct: z.number().int().min(1).max(100),
  warned_at: z.number().int().nonnegative(),
});

export const CostBudgetExceededEventSchema = z.object({
  scope: z.enum(['agent', 'project', 'global']),
  scope_id: z.string().min(1),
  budget_usd: z.number().positive(),
  spent_usd: z.number().nonnegative(),
  exceeded_at: z.number().int().nonnegative(),
});

export const CostEventPayloadMap = {
  'cost.charged': CostChargedEventSchema,
  'cost.budget_warning': CostBudgetWarningEventSchema,
  'cost.budget_exceeded': CostBudgetExceededEventSchema,
};
