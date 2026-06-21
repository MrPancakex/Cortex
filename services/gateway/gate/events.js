/**
 * Thin wrappers that emit gate.* events. Consolidating every gate emit
 * site in one file serves the same purpose as bridge/events.js and
 * tasks/events.js:
 *
 *   1. Rule 3.A lint — every file that calls `emit('x.y', ...)` must
 *      import from @cortex/core/schemas/events. Keeping emits here means
 *      evaluator.js / rate-limit.js / stub-detector.js / permissions.js
 *      stay clean and only this file carries the taxonomy anchor.
 *
 *   2. Single point to attach instrumentation (tracing, sampling,
 *      back-pressure) later instead of sprinkling across every emit
 *      site.
 *
 *   3. Lets tests import an individual helper and stub it, rather than
 *      monkey-patching `@cortex/sdk/events`.
 *
 * Contract: every helper accepts primitives (strings, numbers) so the
 * caller controls the emit timestamp and so the emit decouples from the
 * evaluator's internal shape. Payloads are validated at emit() time via
 * payloadSchemaFor() inside sdk/events/validate.js.
 */

import { emit } from '@cortex/sdk/events';
// Import anchor: events-schema-check.sh requires every emit site to
// import from @cortex/core/schemas/events. The binding below is
// referenced as `void _anchor` so ESLint's unused-vars catch doesn't
// strip the line.
import { EventEnvelopeSchema as _anchor } from '@cortex/core/schemas/events';
void _anchor;

const SOURCE = 'gateway.gate';

function emitWithMeta(subject, payload, meta = {}) {
  return emit(subject, payload, { source: SOURCE, ...meta });
}

/**
 * Emitted by evaluator.js when a policy allow-matches. Dashboards use
 * the (agent_id, route, policy) triple to show per-rule hit counts.
 *
 * @param {{ agentId: string, route: string, policy: string, allowedAt?: number }} args
 */
export function emitGateAllowed({ agentId, route, policy, allowedAt = Date.now() }) {
  emitWithMeta('gate.allowed', {
    agent_id: agentId,
    route,
    policy,
    allowed_at: allowedAt,
  });
}

/**
 * Emitted by evaluator.js when a policy deny-matches (or when the
 * default-deny fallback fires). `reason` is the human-readable label
 * the policy row carries; `policy` is the matched rule id (or
 * 'default' when no rule matched).
 *
 * @param {{ agentId: string, route: string, policy: string, reason: string, deniedAt?: number }} args
 */
export function emitGateDenied({ agentId, route, policy, reason, deniedAt = Date.now() }) {
  emitWithMeta('gate.denied', {
    agent_id: agentId,
    route,
    policy,
    reason,
    denied_at: deniedAt,
  });
}

/**
 * Emitted by rate-limit.js when a bucket is exhausted. Carries the
 * policy's limit + window so dashboards can render "agent X is bumping
 * against 60/min" without re-reading the policy.
 *
 * @param {{ agentId: string, route: string, limit: number, windowMs: number, limitedAt?: number }} args
 */
export function emitGateRateLimited({ agentId, route, limit, windowMs, limitedAt = Date.now() }) {
  emitWithMeta('gate.rate_limited', {
    agent_id: agentId,
    route,
    limit,
    window_ms: windowMs,
    limited_at: limitedAt,
  });
}

/**
 * Emitted by policies.js after a successful refresh (boot, SIGHUP, or
 * POST /v1/api/gate/reload). Dashboards can render "last reload" without
 * tailing the DB.
 *
 * @param {{ policyCount: number, version?: number, loadedAt?: number }} args
 */
export function emitGateLoaded({ policyCount, version, loadedAt = Date.now() }) {
  const payload = { policy_count: policyCount, loaded_at: loadedAt };
  if (typeof version === 'number') payload.version = version;
  emitWithMeta('gate.loaded', payload);
}

/**
 * Emitted by routes.js after a policy upsert/delete via the admin
 * surface. Provides an audit trail without requiring a separate
 * audit_log table.
 *
 * @param {{ policyId: string, op: 'upsert'|'delete', actor?: string, writtenAt?: number }} args
 */
export function emitGatePolicyWritten({ policyId, op, actor, writtenAt = Date.now() }) {
  const payload = { policy_id: policyId, op, written_at: writtenAt };
  if (actor) payload.actor = actor;
  emitWithMeta('gate.policy_written', payload);
}
