/**
 * Declarative gate-policy store. Loads the enabled policy set from
 * gate_policies into an ordered in-memory cache for the evaluator.
 *
 * Invariants:
 *   - Ordered by (priority ASC, id ASC) to match the hot-path SQL and
 *     give deterministic first-match semantics across processes.
 *   - A policy row whose JSON fails the zod check is swallow()'d and
 *     skipped rather than poisoning the whole set.
 *   - Duplicate ids at load time abort the install; the previous cache
 *     stays mounted so the evaluator keeps running against a known-good
 *     set.
 *
 * Mutations (upsert / remove) write the DB first, then refresh the
 * cache. Admin callers don't need to refresh() explicitly.
 */

import { swallow } from '@cortex/sdk/errors';
import {
  parseGatePolicy,
  parseGatePolicySet,
} from '../../../core/schemas/gate.js';
import { getGateStatements } from './statements.js';

let _cache = { version: 0, order: [], byId: new Map() };

/**
 * Rehydrate the policy cache from gate_policies. Returns the new
 * version number so callers can detect reloads.
 */
export function refreshPolicies() {
  const stmts = getGateStatements();
  const rows = stmts.listEnabledPolicies.all();
  const policies = [];
  for (const row of rows) {
    const shaped = rowToPolicy(row);
    const parsed = parseGatePolicy(shaped);
    if (!parsed.success) {
      // One bad row must not poison the whole set — skip + log, keep
      // walking. swallow() bumps a named counter so the operator can
      // see the miss via /health.
      swallow('gate.policies_row_parse_failed', new Error(
        `row ${row.id}: ${parsed.error.message}`,
      ));
      continue;
    }
    policies.push(parsed.data);
  }
  const setCheck = parseGatePolicySet({ version: _cache.version + 1, policies });
  if (!setCheck.success) {
    // Duplicate-id or other set-level invariant failure. Refuse to
    // install the bad set; keep the current cache so the evaluator
    // keeps running.
    swallow('gate.policies_set_invalid', new Error(setCheck.error.message));
    return _cache.version;
  }
  const order = [...policies];
  const byId = new Map(policies.map((p) => [p.id, p]));
  _cache = { version: _cache.version + 1, order, byId };
  return _cache.version;
}

export function listPolicies() {
  return _cache.order.slice();
}

export function orderedPolicies() {
  return _cache.order;
}

export function getPolicyById(id) {
  return _cache.byId.get(id) || null;
}

export function policyCacheSize() {
  return _cache.order.length;
}

export function policyCacheVersion() {
  return _cache.version;
}

/**
 * Insert or update a policy. Validates the shape via zod first; throws
 * on invalid input so the admin surface returns 400. On success the DB
 * row is written and the cache is refreshed.
 */
export function upsertPolicy(policy, { now = Date.now } = {}) {
  const parsed = parseGatePolicy(policy);
  if (!parsed.success) {
    const err = new Error(`invalid policy: ${parsed.error.message}`);
    err.statusCode = 400;
    throw err;
  }
  const stmts = getGateStatements();
  const ts = now();
  const row = policyToRow(parsed.data, ts);
  stmts.upsertPolicy.run(
    row.id,
    row.description,
    row.direction,
    row.action,
    row.subject_json,
    row.resource_json,
    row.effect,
    row.rate_limit_json,
    row.reason_code,
    row.priority,
    row.enabled,
    row.created_at,
    row.updated_at,
  );
  refreshPolicies();
  return parsed.data;
}

/**
 * Delete a policy by id. Returns true when a row was removed. Refreshes
 * the cache only if the delete actually changed a row so an idempotent
 * no-op doesn't thrash the version counter.
 */
export function removePolicy(id) {
  const stmts = getGateStatements();
  const res = stmts.deletePolicy.run(id);
  const removed = (res?.changes || 0) > 0;
  if (removed) refreshPolicies();
  return removed;
}

export function resetPolicyCacheForTests() {
  _cache = { version: 0, order: [], byId: new Map() };
}

// -- internal helpers ------------------------------------------------------

function rowToPolicy(row) {
  return {
    id: row.id,
    description: row.description || undefined,
    direction: row.direction,
    action: row.action,
    subject: safeJson(row.subject_json, {}),
    resource: row.resource_json ? safeJson(row.resource_json, undefined) : undefined,
    effect: row.effect,
    rate_limit: row.rate_limit_json ? safeJson(row.rate_limit_json, undefined) : undefined,
    reason_code: row.reason_code || undefined,
    priority: row.priority,
    enabled: !!row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function policyToRow(policy, ts) {
  return {
    id: policy.id,
    description: policy.description || null,
    direction: policy.direction,
    action: policy.action,
    subject_json: JSON.stringify(policy.subject),
    resource_json: policy.resource ? JSON.stringify(policy.resource) : null,
    effect: policy.effect,
    rate_limit_json: policy.rate_limit ? JSON.stringify(policy.rate_limit) : null,
    reason_code: policy.reason_code || null,
    priority: policy.priority,
    enabled: policy.enabled ? 1 : 0,
    created_at: policy.created_at || ts,
    updated_at: ts,
  };
}

function safeJson(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    swallow('gate.policies_json_parse_failed', err);
    return fallback;
  }
}
