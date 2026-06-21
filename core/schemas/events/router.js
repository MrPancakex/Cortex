/**
 * router.* event payload schemas. Phase 8 adds three admin/observability
 * events for the routing plane:
 *
 *   - router.decision      — one per routing decision (task / bridge /
 *                             reviewer / proxy plane).
 *   - router.loaded        — routing rule set refreshed.
 *   - router.rule_written  — admin upsert/delete of a routing rule row.
 *
 * The task-plane already emits `task.claimed`; the router.decision event
 * is a per-decision audit record carrying the matched rule id + effect so
 * dashboards can show "rule X routed task Y to agent Z" without joining
 * event streams.
 */
import { z } from 'zod';

export const RouterDecisionEventSchema = z.object({
  plane: z.enum(['task', 'bridge', 'reviewer', 'proxy']),
  rule_id: z.string().min(1).optional(),
  target_kind: z.enum(['plugin', 'internal', 'external_url', 'queue', 'drop']).optional(),
  target_value: z.string().optional(),
  effect: z.enum(['route', 'skip', 'filter']).default('route'),
  reason_code: z.string().optional(),
  decided_at: z.number().int().nonnegative(),
});

export const RouterLoadedEventSchema = z.object({
  rule_count: z.number().int().nonnegative(),
  version: z.number().int().nonnegative().optional(),
  loaded_at: z.number().int().nonnegative(),
});

export const RouterRuleWrittenEventSchema = z.object({
  rule_id: z.string().min(1),
  op: z.enum(['upsert', 'delete']),
  actor: z.string().min(1).optional(),
  written_at: z.number().int().nonnegative(),
});

export const RouterEventPayloadMap = {
  'router.decision': RouterDecisionEventSchema,
  'router.loaded': RouterLoadedEventSchema,
  'router.rule_written': RouterRuleWrittenEventSchema,
};
