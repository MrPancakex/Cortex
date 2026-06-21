/**
 * In-memory scope grant store for temporary scope elevation.
 *
 * Grants are held in a process-level Map. They are intentionally lost on
 * gateway restart — that's a design property, not a bug.
 *
 * Constraints enforced here:
 *   - Max TTL: 3600 seconds
 *   - No stacking: new grant replaces any prior grant for the same agent
 *     (the implicit revocation is logged via auditGrant before replacement)
 *   - Periodic reaper sweeps every 30s; evicted grants emit auth.scope_expired
 */

import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { auditGrant } from './audit.js';

/** @type {Map<string, GrantRecord>} keyed by agentBase */
const grantMap = new Map();

/**
 * @typedef {Object} GrantRecord
 * @property {string}  grant_id
 * @property {string}  agent
 * @property {string}  target_scope
 * @property {string}  expires_at      ISO timestamp
 * @property {number}  expires_ms      ms epoch for fast comparisons
 * @property {string}  granted_at
 * @property {string}  granted_by
 * @property {string}  justification
 * @property {string}  revocation_token
 */

const MAX_TTL = 3600;

/**
 * Create a new grant, replacing any existing one for the agent (F-17).
 * If replacing, emits auth.scope_revoked with reason "replaced_by_new_grant".
 *
 * @param {{ agent: string, target_scope: string, ttl_seconds: number, granted_by: string, justification: string }} opts
 * @returns {{ ok: true, grant_id: string, expires_at: string, revocation_token: string } | { ok: false, error: string }}
 */
export function createGrant({ agent, target_scope, ttl_seconds, granted_by, justification }) {
  if (!agent || typeof agent !== 'string') return { ok: false, error: 'invalid_agent' };
  if (!target_scope || typeof target_scope !== 'string') return { ok: false, error: 'invalid_target_scope' };
  if (!Number.isFinite(ttl_seconds) || ttl_seconds <= 0) return { ok: false, error: 'invalid_ttl' };
  if (ttl_seconds > MAX_TTL) return { ok: false, error: 'ttl_too_long' };

  // F-17: log implicit revocation of any existing grant before replacing
  const existing = grantMap.get(agent);
  if (existing) {
    auditGrant('auth.scope_revoked', {
      grant_id: existing.grant_id,
      agent,
      reason: 'replaced_by_new_grant',
      revoked_at: Date.now(),
    });
  }

  const grant_id = randomUUID();
  const revocation_token = randomBytes(16).toString('hex');
  const now = Date.now();
  const expires_ms = now + ttl_seconds * 1000;
  const granted_at = new Date(now).toISOString();
  const expires_at = new Date(expires_ms).toISOString();

  /** @type {GrantRecord} */
  const record = {
    grant_id,
    agent,
    target_scope,
    expires_at,
    expires_ms,
    granted_at,
    granted_by: granted_by || 'unknown',
    justification: justification || '',
    revocation_token,
  };
  grantMap.set(agent, record);
  return { ok: true, grant_id, expires_at, revocation_token };
}

/**
 * Look up an active grant for an agent. Evicts expired grants lazily.
 * @param {string} agent
 * @returns {GrantRecord | null}
 */
export function lookupGrant(agent) {
  const record = grantMap.get(agent);
  if (!record) return null;
  if (Date.now() >= record.expires_ms) {
    grantMap.delete(agent);
    return null;
  }
  return record;
}

/**
 * Revoke a grant by grant_id + revocation_token.
 * Uses timingSafeEqual (F-22). Fixed-length tokens (32-char hex from randomBytes(16))
 * mean a length mismatch reveals no information, but we still guard and return
 * the same error to keep constant-time behaviour on the happy path.
 *
 * @param {string} grant_id
 * @param {string} revocation_token
 * @returns {{ ok: true, agent: string } | { ok: false, error: string }}
 */
export function revokeGrant(grant_id, revocation_token) {
  for (const [agent, record] of grantMap.entries()) {
    if (record.grant_id !== grant_id) continue;
    // F-22: constant-time compare; guard length first (timingSafeEqual throws on mismatch)
    const stored = Buffer.from(record.revocation_token, 'utf8');
    const given  = Buffer.from(typeof revocation_token === 'string' ? revocation_token : '', 'utf8');
    if (stored.length !== given.length || !timingSafeEqual(stored, given)) {
      return { ok: false, error: 'invalid_revocation_token' };
    }
    grantMap.delete(agent);
    return { ok: true, agent };
  }
  return { ok: false, error: 'grant_not_found' };
}

/**
 * List all active grants (expired ones are evicted in the process).
 * @returns {GrantRecord[]}
 */
export function listGrants() {
  const now = Date.now();
  const active = [];
  for (const [agent, record] of grantMap.entries()) {
    if (now >= record.expires_ms) {
      grantMap.delete(agent);
      continue;
    }
    active.push(record);
  }
  return active;
}

/**
 * Periodic reaper — sweeps expired grants, emits auth.scope_expired per eviction.
 * Returns { stop } so the caller can detach on shutdown (F-16).
 *
 * @param {{ intervalMs?: number }} [opts]
 * @returns {{ stop: () => void }}
 */
export function startGrantReaper({ intervalMs = 30_000 } = {}) {
  const handle = setInterval(() => {
    const now = Date.now();
    for (const [agent, record] of grantMap.entries()) {
      if (now >= record.expires_ms) {
        grantMap.delete(agent);
        auditGrant('auth.scope_expired', {
          grant_id: record.grant_id,
          agent,
          expired_at: now,
        });
      }
    }
  }, intervalMs);

  // Don't keep the process alive in tests
  if (handle.unref) handle.unref();

  return { stop: () => clearInterval(handle) };
}

/** Reset the grant map — test helper only. */
export function resetGrantsForTests() {
  grantMap.clear();
}
