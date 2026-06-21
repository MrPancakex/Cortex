/**
 * gate.* event payload schemas. Gateway policy engine decisions —
 * allowed / denied / rate_limited surfaces that let dashboards show why
 * a request was rejected without parsing free-text logs.
 *
 * Phase 7 additions:
 *   - gate.loaded          — policy set refreshed (boot, SIGHUP, admin reload).
 *   - gate.policy_written  — admin upsert/delete of a policy row.
 *
 * Existing three events (allowed / denied / rate_limited) are kept
 * backward-compatible — their shape is unchanged because other subscribers
 * already depend on it.
 */
import { z } from 'zod';
import { AgentIdSchema } from '../_primitives.js';

export const GateAllowedEventSchema = z.object({
  agent_id: AgentIdSchema,
  route: z.string().min(1),
  policy: z.string().min(1),
  allowed_at: z.number().int().nonnegative(),
});

export const GateDeniedEventSchema = z.object({
  agent_id: AgentIdSchema,
  route: z.string().min(1),
  policy: z.string().min(1),
  reason: z.string().min(1),
  denied_at: z.number().int().nonnegative(),
});

export const GateRateLimitedEventSchema = z.object({
  agent_id: AgentIdSchema,
  route: z.string().min(1),
  limit: z.number().int().positive(),
  window_ms: z.number().int().positive(),
  limited_at: z.number().int().nonnegative(),
});

// Phase 7 additions — admin surface events. These fire when the policy
// cache is (re)built or when a policy row is upserted/deleted by the
// admin HTTP surface. Dashboards can render "last reload" and a policy
// write audit trail without tailing the DB.
export const GateLoadedEventSchema = z.object({
  policy_count: z.number().int().nonnegative(),
  version: z.number().int().nonnegative().optional(),
  loaded_at: z.number().int().nonnegative(),
});

export const GatePolicyWrittenEventSchema = z.object({
  policy_id: z.string().min(1),
  op: z.enum(['upsert', 'delete']),
  actor: z.string().min(1).optional(),
  written_at: z.number().int().nonnegative(),
});

export const GateEventPayloadMap = {
  'gate.allowed': GateAllowedEventSchema,
  'gate.denied': GateDeniedEventSchema,
  'gate.rate_limited': GateRateLimitedEventSchema,
  'gate.loaded': GateLoadedEventSchema,
  'gate.policy_written': GatePolicyWrittenEventSchema,
};
