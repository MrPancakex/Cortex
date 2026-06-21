/**
 * Policy evaluator. Walks the ordered policy list and returns the first
 * concrete verdict for a given request.
 *
 * The evaluator is deliberately dumb: it does not make network calls,
 * consult the DB, or call other subsystems. Everything it needs is on
 * the request object or in the in-memory policy cache. Hot-path latency
 * is bounded by policy count × matcher cost (constant per policy).
 *
 * Matching rules (documented in core/schemas/gate.js):
 *   - subject.kind must match. `any` matches every authenticated
 *     subject; `anon` matches only unauthenticated.
 *   - action must equal policy.action unless policy.action === 'any'.
 *   - resource, if present on the policy, must match the request's
 *     resource block (fields the policy omits act as wildcards).
 *
 * A policy's effect of 'next' skips to the next rule — used for
 * "deny unless overridden by a later allow" patterns. If no policy
 * matches, the evaluator returns the configured default (default: deny).
 *
 * identityEquals is injected so callers pass `sameBaseAgent` from
 * @cortex/sdk/auth for agent-matching — the comparator correctly maps
 * session-scoped ids like `nova-3` to their registered base `nova`
 * AND keeps hyphenated bases like `my-agent` vs `my-other-agent`
 * distinct (a lesson from prior phases).
 */

import { swallow } from '@cortex/sdk/errors';
import { sameBaseAgent } from '@cortex/sdk/auth';
import { parseGateDecision } from '../../../core/schemas/gate.js';
import { orderedPolicies } from './policies.js';
import { emitGateAllowed, emitGateDenied } from './events.js';

const DEFAULT_DENY = Object.freeze({
  effect: 'deny',
  reason_code: 'no_matching_policy',
  reason: 'no policy matched; default deny',
});

const DEFAULT_ALLOW = Object.freeze({
  effect: 'allow',
  reason_code: 'default_allow',
  reason: 'no policy matched; default allow',
});

/**
 * Evaluate a request. Returns a validated GateDecision.
 *
 * @param {{
 *   direction?: 'inbound'|'outbound',
 *   subject: { kind: string, id?: string, base?: string, role?: string },
 *   action: string,
 *   resource?: { kind: string, id?: string, status?: string,
 *                assignee?: string, reviewer?: string, priority?: string,
 *                role?: string, method?: string, path?: string, pattern?: string },
 * }} request
 * @param {{ defaultEffect?: 'allow'|'deny',
 *           policies?: Array,
 *           identityEquals?: (a: string, b: string) => boolean }} [opts]
 */
export function evaluate(request, opts = {}) {
  const defaultEffect = opts.defaultEffect || 'deny';
  const policies = Array.isArray(opts.policies) ? opts.policies : orderedPolicies();
  const identityEquals = typeof opts.identityEquals === 'function'
    ? opts.identityEquals
    : sameBaseAgent;
  const shouldEmit = opts.emit !== false;
  let evaluated = 0;
  for (const policy of policies) {
    evaluated += 1;
    if (!matches(policy, request, identityEquals)) continue;
    if (policy.effect === 'next') continue;
    const decision = {
      effect: policy.effect,
      matched: policy.id,
      reason_code: policy.reason_code || `policy:${policy.id}`,
      reason: policy.description || `matched policy ${policy.id}`,
      evaluated_policies: evaluated,
    };
    if (policy.effect === 'rate_limited' && policy.rate_limit) {
      decision.retry_after_ms = policy.rate_limit.window_ms;
    }
    const finalised = finalise(decision);
    if (shouldEmit) emitForDecision(request, finalised);
    return finalised;
  }
  const defaultDecision = finalise({
    ...(defaultEffect === 'allow' ? DEFAULT_ALLOW : DEFAULT_DENY),
    evaluated_policies: evaluated,
  });
  if (shouldEmit) emitForDecision(request, defaultDecision);
  return defaultDecision;
}

function emitForDecision(request, decision) {
  try {
    const agentId = request?.subject?.id
      || request?.subject?.base
      || (request?.subject?.kind === 'anon' ? 'anon' : 'unknown');
    const route = request?.path || request?.action || 'gate';
    const policyLabel = decision.matched || 'default';
    if (decision.effect === 'allow') {
      emitGateAllowed({ agentId, route, policy: policyLabel });
    } else if (decision.effect === 'deny') {
      emitGateDenied({
        agentId,
        route,
        policy: policyLabel,
        reason: decision.reason || decision.reason_code || 'deny',
      });
    }
    // rate_limited decisions are emitted by rate-limit.js at the
    // bucket-exhaustion site — we don't double-emit here.
  } catch (err) {
    // Emit failure must not break the decision path.
    swallow('gate.evaluator_emit_failed', err);
  }
}

function matches(policy, request, identityEquals) {
  if (policy.direction && request.direction && policy.direction !== request.direction) {
    return false;
  }
  if (policy.action !== 'any' && policy.action !== request.action) return false;
  if (!matchSubject(policy.subject, request.subject, identityEquals)) return false;
  if (policy.resource && !matchResource(policy.resource, request.resource)) return false;
  return true;
}

function matchSubject(matcher, subject, identityEquals) {
  if (!matcher || !subject) return false;
  if (matcher.kind === 'any') return subject.kind !== 'anon';
  if (matcher.kind === 'anon') return subject.kind === 'anon';
  if (matcher.kind === 'admin') {
    return subject.kind === 'admin' || subject.role === 'admin';
  }
  if (matcher.kind === 'role') return subject.role === matcher.role;
  if (matcher.kind === 'agent') {
    // Use the injected comparator (default sameBaseAgent) so hyphenated
    // bases and session slots compare correctly. A naive === on
    // subject.id + matcher.agent would miss `nova-3` matching policy
    // subject.agent=`nova`.
    const candidateId = subject.id || subject.base;
    if (!candidateId) return false;
    return identityEquals(candidateId, matcher.agent)
      || subject.base === matcher.agent;
  }
  return false;
}

function matchResource(matcher, resource) {
  if (matcher.kind === 'any') return true;
  if (!resource) return false;
  if (matcher.kind !== resource.kind) return false;
  if (matcher.id && matcher.id !== resource.id) return false;
  if (matcher.status && matcher.status !== resource.status) return false;
  if (matcher.assignee && matcher.assignee !== resource.assignee) return false;
  if (matcher.reviewer && matcher.reviewer !== resource.reviewer) return false;
  if (matcher.priority && matcher.priority !== resource.priority) return false;
  if (matcher.role && matcher.role !== resource.role) return false;
  if (matcher.method && matcher.method !== '*' && matcher.method !== resource.method) return false;
  if (matcher.pattern && !pathMatches(matcher.pattern, resource.path || resource.id)) return false;
  return true;
}

function pathMatches(pattern, value) {
  if (!value) return false;
  // Pattern supports leading/trailing '*' plus embedded '*'. Full regex
  // is deliberately omitted — patterns live in a DB and must be
  // reviewable at a glance.
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  try {
    return new RegExp(`^${escaped}$`).test(String(value));
  } catch (err) {
    swallow('gate.evaluator_pattern_compile_failed', err);
    return false;
  }
}

function finalise(decision) {
  const parsed = parseGateDecision(decision);
  if (parsed.success) return parsed.data;
  swallow('gate.evaluator_decision_shape_invalid', new Error(parsed.error.message));
  // Last-resort deny — the evaluator's output shape failed validation.
  return {
    effect: 'deny',
    reason_code: 'evaluator_shape',
    reason: 'evaluator produced invalid decision',
    evaluated_policies: decision.evaluated_policies || 0,
  };
}
