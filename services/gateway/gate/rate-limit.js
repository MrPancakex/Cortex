/**
 * Token-bucket rate limiter for the gate plane. Three entry points:
 *
 *   - checkIp(req, ts)            — pre-auth IP bucket; cheap defence
 *                                    against unauthenticated floods.
 *   - checkAgent(agentId, ...)    — per-agent bucket applied after auth,
 *                                    independent of any per-policy limit.
 *   - checkPolicyBucket(req, dec, policy, ts)
 *                                 — post-evaluator check against a
 *                                    policy that carries a rate_limit
 *                                    block (bucket key strategy is
 *                                    configurable via spec.key).
 *
 * Buckets live in a Map keyed by a string derived from the request.
 * A periodic sweep drops idle buckets to keep memory flat.
 *
 * The implementation is lock-free: a bucket is a small object and the
 * read-modify-write is synchronous within a single Node event-loop
 * tick. Clustering is out of scope — multi-replica deploys would swap
 * this file for a Redis-backed bucket.
 */

import { swallow } from '@cortex/sdk/errors';
import { emitGateRateLimited } from './events.js';

const IP_DEFAULTS = Object.freeze({ limit: 300, window_ms: 60_000, burst: 60 });
const AGENT_DEFAULTS = Object.freeze({ limit: 100, window_ms: 60_000, burst: 20 });
const SWEEP_INTERVAL_MS = 30_000;
const IDLE_TTL_MS = 5 * 60_000;

const _buckets = new Map();

let _ipRule = { ...IP_DEFAULTS };
let _agentRule = { ...AGENT_DEFAULTS };
let _sweepTimer = null;

/**
 * Configure the limiter. Accepts optional overrides for the IP and
 * per-agent defaults; unspecified values keep the built-ins. Also
 * (re-)starts the sweep timer so tests calling dispose() can restart.
 *
 * @param {{ ip?: { limit: number, window_ms: number, burst?: number },
 *           agent?: { limit: number, window_ms: number, burst?: number } }} [config]
 */
export function configureRateLimiter(config = {}) {
  _ipRule = { ...IP_DEFAULTS, ...(config.ip || {}) };
  _agentRule = { ...AGENT_DEFAULTS, ...(config.agent || {}) };
  startSweep();
}

/**
 * Shut down the sweep timer and clear every bucket. Tests call this
 * between suites so the limiter does not bleed state across runs.
 */
export function disposeRateLimiter() {
  if (_sweepTimer) {
    clearInterval(_sweepTimer);
    _sweepTimer = null;
  }
  _buckets.clear();
}

/**
 * Pre-auth IP bucket. Returns a GateDecision-shaped object when the
 * bucket is exhausted, otherwise null.
 *
 * @param {{ ip?: string }} req
 * @param {number} [ts]
 */
export function checkIp(req, ts = Date.now()) {
  let decision = null;
  try {
    const ip = req?.ip || req?.socket?.remoteAddress || 'unknown';
    const key = `ip:${ip}`;
    const bucket = ensureBucket(key, _ipRule, ts);
    if (!consume(bucket, ts)) {
      decision = {
        effect: 'rate_limited',
        reason_code: 'ip_rate_limited',
        reason: `ip ${ip} exceeded ${_ipRule.limit}/${_ipRule.window_ms}ms`,
        retry_after_ms: remainingWindow(bucket, ts),
        evaluated_policies: 0,
        _emitArgs: {
          agentId: ip,
          route: req?.path || 'unknown',
          limit: _ipRule.limit,
          windowMs: _ipRule.window_ms,
          limitedAt: ts,
        },
      };
    }
  } catch (err) {
    swallow('gate.rate_limit_ip_failed', err);
    return null;
  }
  if (decision) {
    // Emit outside the main try: if emit throws we still return the
    // rate-limit decision — the caller's 429 response matters more than
    // the audit event, and swallow() bumps a counter so operators can
    // see the emit miss.
    safeEmit(decision._emitArgs);
    delete decision._emitArgs;
  }
  return decision;
}

/**
 * Per-agent bucket. Returns a decision when the bucket is exhausted,
 * otherwise null. Used by the auth middleware to cap per-agent request
 * rate independently of any policy-specific bucket.
 *
 * @param {string} agentId
 * @param {{ path?: string }} [req]
 * @param {number} [ts]
 */
export function checkAgent(agentId, req = {}, ts = Date.now()) {
  if (!agentId) return null;
  let decision = null;
  try {
    const key = `a:${agentId}`;
    const bucket = ensureBucket(key, _agentRule, ts);
    if (!consume(bucket, ts)) {
      decision = {
        effect: 'rate_limited',
        reason_code: 'agent_rate_limited',
        reason: `agent ${agentId} exceeded ${_agentRule.limit}/${_agentRule.window_ms}ms`,
        retry_after_ms: remainingWindow(bucket, ts),
        evaluated_policies: 0,
        _emitArgs: {
          agentId,
          route: req?.path || 'unknown',
          limit: _agentRule.limit,
          windowMs: _agentRule.window_ms,
          limitedAt: ts,
        },
      };
    }
  } catch (err) {
    swallow('gate.rate_limit_agent_failed', err);
    return null;
  }
  if (decision) {
    safeEmit(decision._emitArgs);
    delete decision._emitArgs;
  }
  return decision;
}

/**
 * Policy-attached bucket check. Runs only when the matched policy has
 * a rate_limit block; otherwise returns null.
 *
 * @param {{ subject?: object, action?: string, resource?: object, ip?: string, path?: string }} request
 * @param {{ matched?: string, rate_limit?: object, evaluated_policies?: number, reason_code?: string }} decision
 * @param {object} policy  — the matched policy row (for its rate_limit block)
 * @param {number} [ts]
 */
export function checkPolicyBucket(request, decision, policy, ts = Date.now()) {
  if (!decision || !decision.matched) return null;
  const spec = policy?.rate_limit;
  if (!spec) return null;
  let verdict = null;
  try {
    const key = bucketKey(spec.key, request, decision);
    const bucket = ensureBucket(key, spec, ts);
    if (!consume(bucket, ts)) {
      verdict = {
        effect: 'rate_limited',
        matched: decision.matched,
        reason_code: decision.reason_code || 'policy_rate_limited',
        reason: `bucket ${key} exceeded ${spec.limit}/${spec.window_ms}ms`,
        retry_after_ms: remainingWindow(bucket, ts),
        evaluated_policies: decision.evaluated_policies || 0,
        _emitArgs: {
          agentId: request?.subject?.id || request?.subject?.base || 'anon',
          route: request?.path || request?.action || 'policy',
          limit: spec.limit,
          windowMs: spec.window_ms,
          limitedAt: ts,
        },
      };
    }
  } catch (err) {
    swallow('gate.rate_limit_policy_failed', err);
    return null;
  }
  if (verdict) {
    safeEmit(verdict._emitArgs);
    delete verdict._emitArgs;
  }
  return verdict;
}

/**
 * Test-only snapshot of the bucket state. Tests assert token levels
 * without reaching into module internals.
 */
export function snapshotBuckets() {
  const out = {};
  for (const [key, b] of _buckets.entries()) {
    out[key] = {
      tokens: b.tokens,
      capacity: b.capacity,
      limit: b.limit,
      window_ms: b.window_ms,
      updated_at: b.updated_at,
    };
  }
  return out;
}

// -- internal helpers ------------------------------------------------------

function safeEmit(args) {
  try {
    emitGateRateLimited(args);
  } catch (err) {
    // Emit failure must not swallow the rate-limit decision — the
    // caller still returns 429. Bump a dedicated counter so operators
    // see emit misses distinct from bucket bookkeeping errors.
    swallow('gate.rate_limit_emit_failed', err);
  }
}

function ensureBucket(key, spec, ts) {
  let bucket = _buckets.get(key);
  if (!bucket) {
    bucket = {
      tokens: spec.burst || spec.limit,
      capacity: spec.burst || spec.limit,
      limit: spec.limit,
      window_ms: spec.window_ms,
      refill_per_ms: spec.limit / spec.window_ms,
      updated_at: ts,
    };
    _buckets.set(key, bucket);
  }
  return bucket;
}

function consume(bucket, ts) {
  refill(bucket, ts);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

function refill(bucket, ts) {
  const delta = Math.max(0, ts - bucket.updated_at);
  bucket.tokens = Math.min(
    bucket.capacity,
    bucket.tokens + delta * bucket.refill_per_ms,
  );
  bucket.updated_at = ts;
}

function remainingWindow(bucket, ts) {
  // ts is accepted for future "now-aligned" retry hints (e.g. snap to
  // the next bucket boundary). Today the retry is purely a function of
  // the deficit + refill rate — touch ts so linters don't flag the arg.
  void ts;
  const deficit = 1 - bucket.tokens;
  if (deficit <= 0) return 0;
  // Guard against divide-by-zero (a spec.window_ms of 0 would be
  // schema-rejected anyway, but defence in depth). Math.max clamps the
  // minimum retry hint to 100ms so clients don't hot-loop.
  const rate = bucket.refill_per_ms || 1 / (bucket.window_ms || 1);
  return Math.max(100, Math.ceil(deficit / rate));
}

function bucketKey(strategy, request, decision) {
  const subj = request?.subject?.id || request?.subject?.base || 'anon';
  const action = request?.action || 'any';
  const resource = request?.resource?.id || '*';
  switch (strategy) {
    case 'subject': return `s:${subj}`;
    case 'subject+action': return `sa:${subj}:${action}`;
    case 'resource': return `r:${resource}`;
    case 'ip': return `ip:${request?.ip || 'unknown'}`;
    default: return `p:${decision.matched}:${subj}`;
  }
}

function sweep(ts) {
  try {
    for (const [key, b] of _buckets.entries()) {
      if (ts - b.updated_at > IDLE_TTL_MS && b.tokens >= b.capacity) {
        _buckets.delete(key);
      }
    }
  } catch (err) {
    swallow('gate.rate_limit_sweep_failed', err);
  }
}

function startSweep() {
  if (_sweepTimer) clearInterval(_sweepTimer);
  _sweepTimer = setInterval(() => sweep(Date.now()), SWEEP_INTERVAL_MS);
  if (typeof _sweepTimer.unref === 'function') _sweepTimer.unref();
}

// Start the sweep lazily on module load so callers that never call
// configureRateLimiter() still get bounded memory. Tests that want
// precise control call disposeRateLimiter() + configureRateLimiter().
startSweep();
