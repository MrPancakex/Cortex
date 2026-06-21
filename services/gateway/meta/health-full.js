/**
 * Full-chain health handler for GET /v1/api/health/full — PUBLIC (lean) variant.
 *
 * Identical to meta/health-full.js minus the bridge_endpoint check (the
 * bridge plane is cut from the public skeleton). Runs 7 diagnostic checks
 * end-to-end and always returns 200; the body carries per-check ok flags.
 * The export pipeline (Plan E) renames this file to health-full.js.
 */

import { getDb } from '@cortex/sdk/db';
import { loadIdentity, loadTokenRegistryFile, signToken, verifyToken } from '@cortex/sdk/auth';
import { bus } from '@cortex/sdk/events/bus.js';
import { listTasks } from '../tasks/index.js';
import { swallow } from '@cortex/sdk/errors';

const SCHEMA_VERSION = 'v0.2';
const REQUIRED_TABLES = ['tasks', 'projects', 'agents', 'bridge_messages'];

/** @returns {{ ok: boolean, duration_ms: number, [k: string]: unknown }} */
function timed(fn) {
  const start = Date.now();
  try {
    const extra = fn();
    return { ok: true, duration_ms: Date.now() - start, ...extra };
  } catch (err) {
    swallow('health.full_check_failed', err);
    return { ok: false, duration_ms: Date.now() - start, reason: err?.message || 'unknown' };
  }
}

function checkDbReadable() {
  return timed(() => {
    const db = getDb();
    db.prepare('SELECT 1').get();
    return {};
  });
}

function checkDbTables() {
  const start = Date.now();
  try {
    const db = getDb();
    const placeholders = REQUIRED_TABLES.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`,
    ).get(...REQUIRED_TABLES);
    const tablesFound = Number(rows?.n ?? 0);
    const allPresent = tablesFound === REQUIRED_TABLES.length;
    return {
      ok: allPresent,
      duration_ms: Date.now() - start,
      tables_found: tablesFound,
      tables_expected: REQUIRED_TABLES.length,
      ...(!allPresent && { reason: `expected ${REQUIRED_TABLES.length} tables, found ${tablesFound}` }),
    };
  } catch (err) {
    swallow('health.full_check_failed', err);
    return { ok: false, duration_ms: Date.now() - start, reason: err?.message || 'unknown' };
  }
}

function checkIdentityPresent() {
  return timed(() => {
    const identity = loadIdentity();
    if (!identity || typeof identity !== 'object') {
      throw new Error('identity.json missing or not parseable');
    }
    if (!identity.secret) throw new Error('identity.json has no secret field');
    return {};
  });
}

function checkTokenRegistry() {
  return timed(() => {
    const registry = loadTokenRegistryFile();
    if (!registry || typeof registry.agents !== 'object') {
      throw new Error('token-registry.json missing agents object');
    }
    return { agent_count: Object.keys(registry.agents).length };
  });
}

async function checkCookieMint() {
  const start = Date.now();
  try {
    const token = signToken({ kind: 'health' }, { ttlMs: 5_000 });
    const claims = await verifyToken(token);
    if (claims?.kind !== 'health') throw new Error('round-trip claims mismatch');
    return { ok: true, duration_ms: Date.now() - start };
  } catch (err) {
    swallow('health.cookie_mint_failed', err);
    return { ok: false, duration_ms: Date.now() - start, reason: err?.message || 'unknown' };
  }
}

function checkListEndpoint() {
  return timed(() => {
    const result = listTasks({
      query: { limit: 1 },
      actor: { kind: 'admin', id: 'health-probe', base: 'health' },
      isAdmin: true,
    });
    if (!Array.isArray(result?.body?.tasks)) throw new Error('listTasks returned no tasks array');
    return {};
  });
}

async function checkEventsPlane() {
  const start = Date.now();
  try {
    let received = false;
    const unsubscribe = bus.register('health.probe', () => { received = true; });
    bus.publish({ subject: 'health.probe', ts: Date.now() });
    await bus.drainAll();
    unsubscribe();
    if (!received) throw new Error('health.probe event not delivered within drainAll');
    return { ok: true, duration_ms: Date.now() - start };
  } catch (err) {
    swallow('health.events_plane_failed', err);
    return { ok: false, duration_ms: Date.now() - start, reason: err?.message || 'unknown' };
  }
}

function sanitiseChecks(checks, isAnon) {
  if (!isAnon) return checks;
  const out = {};
  for (const [name, result] of Object.entries(checks)) {
    const { reason: _reason, ...safe } = result;
    out[name] = safe;
  }
  return out;
}

export async function fullHealthHandler(ctx) {
  const actor = ctx?.actor;
  const isAnon = !actor || actor.kind === 'anon';

  const checks = {};

  checks.db_readable = checkDbReadable();
  checks.db_tables = checkDbTables();
  checks.identity_present = checkIdentityPresent();
  checks.token_registry = checkTokenRegistry();
  checks.cookie_mint = await checkCookieMint();
  checks.list_endpoint = checkListEndpoint();
  checks.events_plane = await checkEventsPlane();

  const allOk = Object.values(checks).every((c) => c.ok === true);

  return {
    status: 200,
    body: {
      ok: allOk,
      checks: sanitiseChecks(checks, isAnon),
      ts: Date.now(),
      __schema_version: SCHEMA_VERSION,
    },
  };
}
