/**
 * core/schemas/routing.js — Phase 8 contract for the router plane.
 *
 * The router plane makes three kinds of decisions:
 *
 *   1. Task assignment — given a requesting agent + platform, which pending
 *      task (if any) should be handed to it next?
 *   2. Bridge routing — given a sender + a symbolic recipient (to_role,
 *      to_agent, to_task), which concrete session(s) receive the message?
 *   3. Reviewer selection — given a task that needs review, which reviewer
 *      agent (load-balanced) is assigned?
 *
 * All three are expressed as routing rules. Each rule has a scope (which
 * decision kind it participates in), a match (conditions on the subject and
 * resource), and a target (the destination or assignment strategy).
 *
 * Provider-route matching (lifted from lib/proxy.js) is also expressed as
 * routing rules of scope.plane='proxy', so the router owns every
 * "where does this go?" question across the gateway.
 */
import { z } from 'zod';

// Scope — which routing decision a rule participates in. One rule, one scope.
// Plane is the primary discriminator; `action` is optional for per-rule
// sub-scoping inside a plane without another enum bump.
export const RoutingScopeSchema = z.object({
  plane: z.enum(['task', 'bridge', 'reviewer', 'proxy']),
  action: z.string().min(1).optional(),
});

// Match — conditions under which the rule fires. All specified conditions
// must hold (AND); omitted conditions default to "any". Field names mirror
// what the matchers in match-route.js actually read so there is no
// translation layer between schema and runtime.
export const RoutingMatchSchema = z.object({
  // Task-plane matchers
  task_priority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  task_platform: z.string().min(1).optional(),
  task_project: z.string().min(1).optional(),
  task_phase: z.string().min(1).optional(),
  task_tags: z.array(z.string().min(1)).max(64).optional(),
  title_pattern: z.string().min(1).optional(),
  required_capabilities: z.string().min(1).optional(),
  // Agent / subject side
  agent_role: z.string().min(1).optional(),
  agent_base: z.string().min(1).optional(),
  agent_platform: z.string().min(1).optional(),
  // Bridge-plane matchers
  bridge_kind: z.enum(['agent', 'role', 'task', 'broadcast']).optional(),
  from_role: z.string().min(1).optional(),
  from_base: z.string().min(1).optional(),
  to_role: z.string().min(1).optional(),
  to_platform: z.string().min(1).optional(),
  // Reviewer-plane matchers
  reviewer_platform: z.string().min(1).optional(),
  reviewer_base: z.string().min(1).optional(),
  // Proxy-plane matchers
  path_prefix: z.string().min(1).optional(),
  path_pattern: z.string().min(1).optional(),
  // Free-form attributes for future matchers without another schema bump.
  attributes: z.record(z.string(), z.string()).optional(),
});

// Target — where the rule sends its decision. Discriminated by `kind`:
//   - plugin       : hand off to a named plugin handler
//   - internal     : internal route, by name
//   - external_url : proxy upstream URL
//   - queue        : enqueue for async processing
//   - drop         : no target; record and stop
//
// `effect` governs how matchers compose: 'route' is the default (fire this
// rule), 'skip' means "rule matches but don't dispatch — used to veto a
// later rule", and 'filter' means "rule matches and narrows the recipient
// set via target.filter".
export const RoutingTargetFilterSchema = z.object({
  role: z.string().min(1).optional(),
  platform: z.string().min(1).optional(),
  base: z.string().min(1).optional(),
}).optional();

export const RoutingTargetSchema = z.object({
  kind: z.enum(['plugin', 'internal', 'external_url', 'queue', 'drop']),
  value: z.string().min(1),
  effect: z.enum(['route', 'skip', 'filter']).default('route'),
  strip_prefix: z.string().optional(),
  preserve_agent_prefix: z.boolean().default(true),
  members: z.array(z.string().min(1)).max(256).optional(),
  strategy: z.enum(['round_robin', 'least_busy', 'random']).optional(),
  filter: RoutingTargetFilterSchema,
});

// Rule — the shape rows in routing_rules deserialize into.
export const RoutingRuleSchema = z.object({
  id: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
  scope: RoutingScopeSchema,
  match: RoutingMatchSchema,
  target: RoutingTargetSchema,
  priority: z.number().int().min(0).max(10_000).default(1000),
  enabled: z.boolean().default(true),
  created_at: z.number().int().nonnegative().optional(),
  updated_at: z.number().int().nonnegative().optional(),
});

// Table — the full routing table as loaded by rules.js.
export const RoutingTableSchema = z.object({
  version: z.number().int().nonnegative().default(1),
  rules: z.array(RoutingRuleSchema),
}).superRefine((val, ctx) => {
  const seen = new Map();
  for (let i = 0; i < val.rules.length; i++) {
    const id = val.rules[i].id;
    if (seen.has(id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['rules', i, 'id'],
        message: `duplicate routing rule id: ${id} (also at index ${seen.get(id)})`,
      });
    }
    seen.set(id, i);
  }
});

// Convenience parse helpers.
export function parseRoutingRule(obj) {
  return RoutingRuleSchema.safeParse(obj);
}

export function parseRoutingTable(obj) {
  return RoutingTableSchema.safeParse(obj);
}
