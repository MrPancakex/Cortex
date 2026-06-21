/**
 * core/schemas/gate.js — Phase 7 contract for the gate plane.
 *
 * A gate policy is a declarative (matcher, effect) pair evaluated against an
 * incoming request. The evaluator walks an ordered list of policies and
 * returns the first concrete allow/deny/rate_limited verdict. Three families
 * of matchers cover the current use cases:
 *
 *   - Subject matchers    — identify WHO is asking (agent, role, admin,
 *                           anon, any).
 *   - Action matchers     — identify WHAT they want to do (HTTP request,
 *                           task state transition, bridge send, ...).
 *   - Resource matchers   — identify WHICH thing they want to touch (task id,
 *                           agent id, project id, arbitrary path pattern).
 *
 * Rate-limit policies carry an additional `rate_limit` block describing the
 * token-bucket shape; hitting the cap evaluates to `rate_limited` (distinct
 * from `deny`) so the caller can return 429 vs. 403.
 *
 * Every field is required unless explicitly .optional(). No silent drift —
 * adding a new matcher kind means editing this file first.
 */
import { z } from 'zod';

// Direction — inbound requests vs. outbound responses. Phase 7 only uses
// 'inbound', but the shape accommodates egress filters (e.g., redact secrets
// from proxy responses) without a schema bump.
export const GateDirectionSchema = z.enum(['inbound', 'outbound']);

// Action — every gated operation gets a string id. The enum lists the current
// universe; new action strings require editing this file.
export const GateActionSchema = z.enum([
  // HTTP surface
  'http.request',
  // Task state transitions
  'task.claim',
  'task.progress',
  'task.submit',
  'task.release',
  'task.approve',
  'task.reject',
  'task.reassign',
  'task.cancel',
  'task.comment',
  'task.reopen',
  'task.delete',
  // Bridge
  'bridge.send',
  'bridge.reply',
  'bridge.broadcast',
  'bridge.delete',
  // Subagent lifecycle
  'subagent.spawn',
  'subagent.close',
  // Admin surface
  'admin.registry.write',
  'admin.policy.write',
  'admin.routing.write',
  // Submission gates (stub detector, journal completeness)
  'submission.validate',
  // Rate-limit pseudo-action — matches every other action when used alone
  'any',
]);

// Subject matcher — who is asking. `kind` drives which optional fields apply:
//   - agent : specific base agent id (e.g. "nova"); session-scoped ids match
//             against their resolved base (nova-3 -> nova).
//   - role  : registered role in the token registry (reviewer, admin, bot).
//   - admin : shorthand for role=admin.
//   - any   : matches every authenticated subject.
//   - anon  : matches unauthenticated callers (pre-auth gates only).
export const GateSubjectMatcherSchema = z.object({
  kind: z.enum(['agent', 'role', 'admin', 'any', 'anon']),
  agent: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
}).superRefine((val, ctx) => {
  if (val.kind === 'agent' && !val.agent) {
    ctx.addIssue({ code: 'custom', message: "subject.kind='agent' requires subject.agent" });
  }
  if (val.kind === 'role' && !val.role) {
    ctx.addIssue({ code: 'custom', message: "subject.kind='role' requires subject.role" });
  }
});

// Resource matcher — which thing is being touched. Optional; rules that don't
// care about the resource simply omit it (matches everything).
export const GateResourceMatcherSchema = z.object({
  kind: z.enum(['task', 'agent', 'project', 'path', 'any']),
  id: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  assignee: z.string().min(1).optional(),
  reviewer: z.string().min(1).optional(),
  priority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  role: z.string().min(1).optional(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', '*']).optional(),
  pattern: z.string().min(1).optional(),
}).refine((val) => val.kind !== 'path' || !!val.pattern, {
  message: "resource.kind='path' requires resource.pattern",
});

// Effect — the verdict a matching policy returns. The evaluator short-circuits
// on the first concrete verdict; 'next' falls through to the next policy.
export const GateEffectSchema = z.enum(['allow', 'deny', 'rate_limited', 'next']);

// Rate-limit block — governs the token bucket when a policy is rate-limited
// or when an allow policy additionally attaches a bucket.
export const GateRateLimitSchema = z.object({
  key: z.enum(['subject', 'resource', 'subject+action', 'ip']),
  limit: z.number().int().positive().max(1_000_000),
  window_ms: z.number().int().positive().max(24 * 60 * 60 * 1000),
  burst: z.number().int().positive().max(1_000_000).optional(),
});

// Policy — the individual rule evaluated by the engine. `priority` is a
// small integer; lower = earlier. Ties broken by insertion order (id ASC).
export const GatePolicySchema = z.object({
  id: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
  direction: GateDirectionSchema.default('inbound'),
  action: GateActionSchema,
  subject: GateSubjectMatcherSchema,
  resource: GateResourceMatcherSchema.optional(),
  effect: GateEffectSchema,
  rate_limit: GateRateLimitSchema.optional(),
  reason_code: z.string().max(64).optional(),
  priority: z.number().int().min(0).max(10_000).default(1000),
  enabled: z.boolean().default(true),
  created_at: z.number().int().nonnegative().optional(),
  updated_at: z.number().int().nonnegative().optional(),
});

// Policy set — what the evaluator loads into memory. Duplicates by id are
// rejected at load time.
export const GatePolicySetSchema = z.object({
  version: z.number().int().nonnegative().default(1),
  policies: z.array(GatePolicySchema),
}).superRefine((val, ctx) => {
  const seen = new Map();
  for (let i = 0; i < val.policies.length; i++) {
    const id = val.policies[i].id;
    if (seen.has(id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['policies', i, 'id'],
        message: `duplicate policy id: ${id} (also at index ${seen.get(id)})`,
      });
    }
    seen.set(id, i);
  }
});

// Decision — what the evaluator returns. `matched` names the policy that
// produced the verdict; `reason_code` is the machine-readable label surfaced
// to clients.
export const GateDecisionSchema = z.object({
  effect: z.enum(['allow', 'deny', 'rate_limited']),
  matched: z.string().min(1).optional(),
  reason_code: z.string().max(64).optional(),
  reason: z.string().max(500).optional(),
  retry_after_ms: z.number().int().nonnegative().optional(),
  evaluated_policies: z.number().int().nonnegative().default(0),
});

// Permission grant — fine-grained (subject, permission, resource) tuple.
// Used by gate/permissions.js for sub-policy permission checks inside
// handlers. Distinct from GatePolicySchema because permissions are additive
// grants, not deny-by-default rules.
export const GatePermissionSchema = z.object({
  subject_id: z.string().min(1),
  permission: z.string().min(1).max(64),
  resource_kind: z.string().min(1).max(32).nullable().optional(),
  resource_id: z.string().min(1).max(128).nullable().optional(),
  granted_at: z.number().int().nonnegative().optional(),
  expires_at: z.number().int().nonnegative().nullable().optional(),
});

// Convenience parse helpers — every consumer uses these so unknown extra
// fields are stripped (not silently carried forward).
export function parseGatePolicy(obj) {
  return GatePolicySchema.safeParse(obj);
}

export function parseGatePolicySet(obj) {
  return GatePolicySetSchema.safeParse(obj);
}

export function parseGateDecision(obj) {
  return GateDecisionSchema.safeParse(obj);
}

export function parseGatePermission(obj) {
  return GatePermissionSchema.safeParse(obj);
}
