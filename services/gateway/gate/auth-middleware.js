/**
 * Gate-plane auth middleware. Derives the subject identity from the
 * incoming request's token header and attaches it to `ctx.auth` so the
 * evaluator downstream has a populated subject block.
 *
 * Identity is derived SERVER-SIDE from the token hash. The only trusted
 * input is the bearer token, which is hashed and compared to the
 * registry.  Headers like X-Agent-Id are ignored — the evaluator
 * distrusts any client-supplied identity claim.
 *
 * Two backends are supported:
 *   - A pluggable registry loader (`config.registryLoader`) for tests
 *     that inject a synthetic registry.
 *   - The on-disk registry snapshot stored in gate_registry_snapshot,
 *     refreshed by the boot process (or sdk/auth init) on SIGHUP.
 *
 * Supported header shapes:
 *   - Authorization: Bearer <token>
 *   - X-Cortex-Token: <token>  (legacy — parity with the current gateway)
 *
 * Defense-in-depth:
 *   F-21: findByToken uses a pre-built Map for O(1) lookup. Corrupt rows
 *         increment a counter and log to stderr rather than silently swallowing.
 *   F-08: resolveSubject accepts opts.detectPeerUid (injectable for tests).
 *         When non-null and mismatched, returns 401 uid_bearer_mismatch.
 *         Production stub always returns null (Bun provides no peer-UID API).
 */

import { timingSafeEqual } from 'node:crypto';
import { swallow } from '@cortex/sdk/errors';
import { SHA256_HEX_RE, sameBaseAgent, resolveBaseAgent, sha256Hex } from '@cortex/sdk/auth';
import { getGateStatements } from './statements.js';
import { lookupGrant } from '../auth/grants.js';
import { resolveScopeFromBearer, hasBearerAssignment } from '../auth/scope-config.js';

// -- F-21: O(1) token index -------------------------------------------------

// Expected UID per agent base name (populated from /etc/passwd at startup).
// Configurable via CORTEX_AGENT_UIDS (JSON string: '{"nova":1003}').
// Defaults to {} — no UID-enforcement unless the operator sets the env var.
// Override via opts.expectedUids in tests / multi-tenant setups.
function buildKnownAgentUids() {
  const raw = process.env.CORTEX_AGENT_UIDS;
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { return {}; }
}
const KNOWN_AGENT_UIDS = Object.freeze(buildKnownAgentUids());

/** Build a Map<hash, {agentId, hash, base, role, platform}> from a registry. */
function buildTokenIndex(registry) {
  const index = new Map();
  const agents = registry?.agents;
  if (!agents || typeof agents !== 'object') return index;
  let corruptCount = 0;
  for (const [agentId, config] of Object.entries(agents)) {
    try {
      const stored = config?.hash;
      if (typeof stored !== 'string' || stored.length !== 64) {
        corruptCount++;
        process.stderr.write(`[gate.auth] corrupt registry entry for "${agentId}": bad or missing hash\n`);
        continue;
      }
      index.set(stored.toLowerCase(), {
        agentId,
        hash: stored,
        base: config.base || resolveBaseAgent(agentId),
        role: config.role || 'agent',
        platform: config.platform || null,
      });
    } catch (err) {
      corruptCount++;
      process.stderr.write(`[gate.auth] exception hydrating registry entry "${agentId}": ${err?.message}\n`);
    }
  }
  if (corruptCount > 0) {
    process.stderr.write(`[gate.auth] registry loaded with ${corruptCount} corrupt entries\n`);
  }
  return index;
}

/**
 * Resolve the subject for a ctx-shaped object. The gateway's adapter
 * pattern passes `ctx = { method, path, headers, body, actor, ... }`;
 * this function reads `headers.authorization` OR `headers['x-cortex-token']`
 * (case-insensitive via the normaliser below), derives the identity,
 * and returns an auth block suitable for the evaluator.
 *
 * Defense-in-depth extensions (F-08, F-18):
 *   - opts.detectPeerUid: (ctx) => number|null — injected for tests; production
 *     default always returns null (Bun has no peer-UID API for TCP/Unix sockets).
 *   - opts.expectedUids: Map<base, number> — override the default KNOWN_AGENT_UIDS.
 *   - When detectPeerUid returns a UID that does NOT match the agent's expected UID,
 *     returns { kind: 'anon', reason: 'uid_bearer_mismatch', status: 401 }.
 *     If UID cannot be determined (null), allow continues normally.
 *
 * @param {{ headers?: object }} ctx
 * @param {{
 *   registryLoader?: () => { agents?: object },
 *   detectPeerUid?: (ctx: object) => number|null,
 *   expectedUids?: Record<string, number>,
 * }} [opts]
 * @returns {{ kind: 'agent'|'admin'|'anon', id?: string, base?: string,
 *             role?: string, scope?: string, platform?: string, reason?: string,
 *             status?: number, tokenHash?: string }}
 */
export function resolveSubject(ctx, opts = {}) {
  const token = extractToken(ctx);
  if (!token) return { kind: 'anon' };
  try {
    const registry = (opts.registryLoader || defaultRegistryLoader)();
    const match = findByToken(registry, token);
    if (!match) {
      return { kind: 'anon', reason: 'token_not_found' };
    }
    const base = match.base;

    // F-08: UID-vs-bearer cross-check (Unix socket defense-in-depth).
    // Production detectPeerUid always returns null (Bun has no peer-UID API).
    // Tests inject a synthetic UID via opts.detectPeerUid.
    const detectPeerUid = typeof opts.detectPeerUid === 'function'
      ? opts.detectPeerUid
      : _defaultDetectPeerUid;
    const peerUid = detectPeerUid(ctx);
    if (peerUid !== null && peerUid !== undefined) {
      const uidMap = opts.expectedUids ?? KNOWN_AGENT_UIDS;
      const expectedUid = uidMap[base] ?? null;
      if (expectedUid !== null && peerUid !== expectedUid) {
        process.stderr.write(
          `[gate.auth] uid_bearer_mismatch: base=${base} expectedUid=${expectedUid} peerUid=${peerUid}\n`,
        );
        return { kind: 'anon', reason: 'uid_bearer_mismatch', status: 401 };
      }
    }

    // Check for an active scope grant. lookupGrant returns null for
    // missing OR expired grants (expired ones are evicted on the spot).
    const grant = lookupGrant(base);
    // Precedence: active grant > explicit bearer_scopes.json assignment > base.
    // F-#7 (round-8): the fallback must distinguish "no assignment exists" from
    // an explicit `scope: "anon"` operator quarantine — resolveScopeFromBearer
    // returns 'anon' for BOTH, so gate the fallback on hasBearerAssignment():
    //   - explicit assignment present (incl. an intentional 'anon') → PRESERVE
    //     it verbatim, so a quarantine is never silently upgraded.
    //   - truly absent → fall back to the agent's own BASE scope (non-admin) or
    //     'admin' (admin). Falling back to a generic 'agent' here would defeat
    //     the `actor.scope ?? actor.base` fallback in server.js (:278) and
    //     auth/check (:280), demoting agents below their base-keyed rules.
    const bearerScope = resolveScopeFromBearer(match.hash);
    const scope = grant
      ? grant.target_scope
      : hasBearerAssignment(match.hash)
        ? bearerScope
        : match.role === 'admin'
          ? 'admin'
          : base;
    return {
      kind: match.role === 'admin' ? 'admin' : 'agent',
      id: match.agentId,
      base,
      role: match.role || 'agent',
      scope,
      platform: match.platform || null,
      tokenHash: match.hash,
    };
  } catch (err) {
    swallow('gate.auth_resolve_failed', err);
    return { kind: 'anon', reason: 'auth_error' };
  }
}

/** Production peer-UID stub. Bun exposes no TCP/Unix socket peer-credential API. */
function _defaultDetectPeerUid(_ctx) {
  return null;
}

/**
 * Validate that a path-prefix agent id (e.g. `/agent/nova-3/...`)
 * matches the authenticated base. Returns true when they share a base
 * OR when no path prefix was present. False when the path claims an
 * identity that the token does not confirm.
 *
 * Uses `sameBaseAgent` from @cortex/sdk/auth so session-scoped ids and
 * hyphenated bases compare correctly (regression: `my-agent` vs
 * `my-other-agent` must stay distinct).
 */
export function reconcilePathIdentity(pathAgentId, subject) {
  if (!pathAgentId) return true;
  if (!subject || subject.kind === 'anon') return false;
  const candidate = subject.id || subject.base;
  if (!candidate) return false;
  return sameBaseAgent(candidate, pathAgentId);
}

/**
 * Write a new registry snapshot row. Called by the gateway's boot
 * (after loading the on-disk token registry) and by SIGHUP reload. The
 * snapshot is the gate plane's authoritative identity source.
 *
 * @param {object} registry  — { agents: { [id]: { hash, role?, base?, platform? } } }
 * @param {number} [now]
 */
export function writeRegistrySnapshot(registry, now = Date.now()) {
  try {
    const stmts = getGateStatements();
    const json = JSON.stringify(registry ?? { agents: {} });
    stmts.upsertRegistrySnapshot.run(json, now);
    return true;
  } catch (err) {
    swallow('gate.auth_registry_write_failed', err);
    return false;
  }
}

/**
 * Load the current registry snapshot. Returns { agents: {} } when the
 * row is absent or unparseable so callers always see a usable shape.
 */
export function readRegistrySnapshot() {
  try {
    const stmts = getGateStatements();
    const row = stmts.getRegistrySnapshot.get();
    if (!row || !row.json) return { agents: {} };
    return JSON.parse(row.json);
  } catch (err) {
    swallow('gate.auth_registry_read_failed', err);
    return { agents: {} };
  }
}

// -- internal helpers ------------------------------------------------------

function extractToken(ctx) {
  const headers = ctx?.headers;
  if (!headers) return null;
  const authz = readHeader(headers, 'authorization');
  if (typeof authz === 'string' && authz.length > 0) {
    const m = authz.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  const xToken = readHeader(headers, 'x-cortex-token');
  if (typeof xToken === 'string' && xToken.length > 0) {
    // Bun joins duplicate headers with ', ' — reject those explicitly.
    if (xToken.includes(',')) return null;
    return xToken.trim();
  }
  return null;
}

function readHeader(headers, name) {
  if (typeof headers.get === 'function') {
    return headers.get(name);
  }
  // Plain-object headers — try both original + lowercase.
  if (Object.prototype.hasOwnProperty.call(headers, name)) return headers[name];
  const lower = name.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(headers, lower)) return headers[lower];
  return null;
}

/**
 * F-21: O(1) token lookup via pre-built Map index.
 *
 * Previously this was O(n) over all entries with per-entry try/catch that
 * silently swallowed corrupt rows. Now:
 *   - buildTokenIndex pre-validates all entries and logs corrupt ones to stderr.
 *   - lookup is a single Map.get() per candidate hash (O(1)).
 *   - timingSafeEqual is still used to compare the hash to prevent timing leaks.
 *
 * The registry Map is rebuilt each call because the registry snapshot can
 * change between calls (SIGHUP reload). For high-QPS production this could
 * be cached with the snapshot's updated_at timestamp as a cache key; that
 * optimization is deferred until profiling shows it's needed.
 */
function findByToken(registry, rawToken) {
  if (!registry || typeof registry !== 'object') return null;
  const index = buildTokenIndex(registry);
  if (index.size === 0) return null;

  const hashedRawToken = sha256Hex(rawToken);
  const candidates = [hashedRawToken];
  if (SHA256_HEX_RE.test(rawToken)) {
    candidates.push(rawToken.toLowerCase());
  }

  for (const candidate of candidates) {
    const entry = index.get(candidate);
    if (!entry) continue;
    // Timing-safe comparison to prevent hash enumeration via timing side-channel.
    try {
      const storedBuf = Buffer.from(entry.hash, 'hex');
      const candidateBuf = Buffer.from(candidate, 'hex');
      if (storedBuf.length === candidateBuf.length && timingSafeEqual(storedBuf, candidateBuf)) {
        return entry;
      }
    } catch (err) {
      process.stderr.write(`[gate.auth] timingSafeEqual failed for candidate: ${err?.message}\n`);
    }
  }
  return null;
}

function defaultRegistryLoader() {
  return readRegistrySnapshot();
}
