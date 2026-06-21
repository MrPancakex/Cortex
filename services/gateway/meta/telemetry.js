/**
 * Telemetry persistence (Foundation F2).
 *
 * Owns the `telemetry` table (migration 016): one row per self-reported
 * call. Distinct from proxy_logs — proxy_logs records calls that flow
 * THROUGH the gateway proxy; telemetry records usage self-reported by an
 * agent or MCP tool for calls that do not traverse the proxy.
 *
 * Three concerns live here:
 *   insertTelemetry({ … }) — write one row (fire-and-forget; a DB failure
 *                            must never block a tool dispatch or HTTP
 *                            response). Failures counted via swallow().
 *   sumTelemetryByAgent()  — aggregate for cost_summary / my_stats.
 *   sumTelemetryByProject()— aggregate for cost_per_project.
 *
 * Statements are cached per-db handle (same invalidate-on-rotate pattern as
 * proxy/statements.js) so resetDbForTests() + a fresh getDb() in a test does
 * not silently query a stale handle.
 */

import { getDb, createStatements } from '@cortex/sdk/db';
import { swallow } from '@cortex/sdk/errors';

const SPECS = [
  {
    name: 'insertTelemetry',
    sql: `INSERT INTO telemetry
      (agent_id, project_id, method, endpoint, model, provider,
       tokens_in, tokens_out, cost_usd, latency_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  },
  {
    name: 'sumByAgent',
    sql: `SELECT
        COUNT(*)               AS requests,
        COALESCE(SUM(tokens_in), 0)  AS tokens_in,
        COALESCE(SUM(tokens_out), 0) AS tokens_out,
        COALESCE(SUM(cost_usd), 0)   AS total_cost_usd
      FROM telemetry
      WHERE agent_id = ?`,
  },
  {
    name: 'sumByProject',
    sql: `SELECT
        COUNT(*)               AS requests,
        COALESCE(SUM(tokens_in), 0)  AS tokens_in,
        COALESCE(SUM(tokens_out), 0) AS tokens_out,
        COALESCE(SUM(cost_usd), 0)   AS total_cost_usd
      FROM telemetry
      WHERE project_id = ?`,
  },
  {
    name: 'sumAll',
    sql: `SELECT
        COUNT(*)               AS requests,
        COALESCE(SUM(tokens_in), 0)  AS tokens_in,
        COALESCE(SUM(tokens_out), 0) AS tokens_out,
        COALESCE(SUM(cost_usd), 0)   AS total_cost_usd
      FROM telemetry`,
  },
  {
    name: 'listRecent',
    sql: `SELECT id, agent_id, project_id, method, endpoint, model, provider,
        tokens_in, tokens_out, cost_usd, latency_ms, created_at
      FROM telemetry
      ORDER BY created_at DESC
      LIMIT ?`,
  },
  // C3: per-session surface — group telemetry rows by agent_id (the session slot
  // id written by cortex-report.sh's X-Cortex-Session header). Each row in the
  // result is one session slot; the frontend's requests_by_agent / usage_by_session
  // maps consume this to show per-session breakdowns without a separate endpoint.
  {
    name: 'sumBySession',
    sql: `SELECT
        agent_id                           AS session_id,
        COUNT(*)                           AS requests,
        COALESCE(SUM(tokens_in), 0)        AS tokens_in,
        COALESCE(SUM(tokens_out), 0)       AS tokens_out,
        COALESCE(SUM(cost_usd), 0)         AS total_cost_usd
      FROM telemetry
      WHERE agent_id IS NOT NULL
      GROUP BY agent_id
      ORDER BY requests DESC`,
  },
  // proxy_logs aggregations (migration 005). The cost MCP tools fold these
  // together with the telemetry sums above — the two tables are disjoint by
  // migration-016 design (telemetry = calls that do NOT traverse the proxy),
  // so summing both is a union, not a double-count. proxy_logs uses
  // input_tokens / output_tokens column names (vs telemetry's tokens_in /
  // tokens_out); we alias them to the telemetry shape so callers fold a single
  // {requests, tokens_in, tokens_out, total_cost_usd} contract.
  {
    name: 'proxySumByAgent',
    sql: `SELECT
        COUNT(*)                        AS requests,
        COALESCE(SUM(input_tokens), 0)  AS tokens_in,
        COALESCE(SUM(output_tokens), 0) AS tokens_out,
        COALESCE(SUM(cost_usd), 0)      AS total_cost_usd
      FROM proxy_logs
      WHERE agent_id = ?`,
  },
  // BASE-ROLLUP variants (R1b FIX 1). "My cost" = an agent's totals across ALL
  // its session slots. proxy_logs stamps the BASE id (e.g. `nova`) while
  // telemetry stamps the SESSION SLOT (e.g. `nova-2`); aggregating by the
  // exact configured id (the slot) would MISS every base-stamped proxy row.
  // These match the base PLUS any `<base>-<slot>` id: `id = base OR id LIKE
  // base || '-%'`. The caller peels the slot suffix off the configured id
  // before calling (see cost_summary.js / my_stats.js) so `base` is already
  // bare. NB: current agent ids (nova/orion) contain no LIKE metacharacters
  // (`_`/`%`), so the `-%` suffix match is exact for them.
  {
    name: 'proxySumByAgentBase',
    sql: `SELECT
        COUNT(*)                        AS requests,
        COALESCE(SUM(input_tokens), 0)  AS tokens_in,
        COALESCE(SUM(output_tokens), 0) AS tokens_out,
        COALESCE(SUM(cost_usd), 0)      AS total_cost_usd
      FROM proxy_logs
      WHERE agent_id = ? OR agent_id LIKE ? || '-%'`,
  },
  {
    name: 'sumByAgentBase',
    sql: `SELECT
        COUNT(*)               AS requests,
        COALESCE(SUM(tokens_in), 0)  AS tokens_in,
        COALESCE(SUM(tokens_out), 0) AS tokens_out,
        COALESCE(SUM(cost_usd), 0)   AS total_cost_usd
      FROM telemetry
      WHERE agent_id = ? OR agent_id LIKE ? || '-%'`,
  },
  {
    name: 'proxySumByProject',
    sql: `SELECT
        COUNT(*)                        AS requests,
        COALESCE(SUM(input_tokens), 0)  AS tokens_in,
        COALESCE(SUM(output_tokens), 0) AS tokens_out,
        COALESCE(SUM(cost_usd), 0)      AS total_cost_usd
      FROM proxy_logs
      WHERE project_id = ?`,
  },
];

let _cached = null;
let _cachedDb = null;

export function getTelemetryStatements() {
  const db = getDb();
  if (_cached && _cachedDb === db) return _cached;
  _cached = createStatements(db, SPECS);
  _cachedDb = db;
  return _cached;
}

export function resetTelemetryStatementsForTests() {
  _cached = null;
  _cachedDb = null;
}

function intOrZero(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function nonNegNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function strOrNull(v) {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Persist one telemetry row. Tolerant of partial input — every field except
 * created_at is optional (created_at defaults to now). Returns true on a
 * successful insert, false on any failure (counted via swallow so degraded
 * state surfaces on /health).
 *
 * @param {{
 *   agent_id?: string, agentId?: string,
 *   project_id?: string, projectId?: string,
 *   method?: string, endpoint?: string, model?: string, provider?: string,
 *   tokens_in?: number, tokens_out?: number, cost_usd?: number,
 *   latency_ms?: number, created_at?: number, ts?: number
 * }} entry
 * @returns {boolean}
 */
export function insertTelemetry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const createdAt = Number(entry.created_at ?? entry.ts);
  const row = {
    agent_id: strOrNull(entry.agent_id ?? entry.agentId),
    project_id: strOrNull(entry.project_id ?? entry.projectId),
    method: strOrNull(entry.method),
    endpoint: strOrNull(entry.endpoint),
    model: strOrNull(entry.model),
    provider: strOrNull(entry.provider),
    tokens_in: intOrZero(entry.tokens_in ?? entry.tokensIn),
    tokens_out: intOrZero(entry.tokens_out ?? entry.tokensOut),
    cost_usd: nonNegNumber(entry.cost_usd ?? entry.costUsd),
    latency_ms: intOrZero(entry.latency_ms ?? entry.latencyMs),
    created_at: Number.isFinite(createdAt) && createdAt > 0 ? Math.floor(createdAt) : Date.now(),
  };
  try {
    getTelemetryStatements().insertTelemetry.run(
      row.agent_id,
      row.project_id,
      row.method,
      row.endpoint,
      row.model,
      row.provider,
      row.tokens_in,
      row.tokens_out,
      row.cost_usd,
      row.latency_ms,
      row.created_at,
    );
    return true;
  } catch (err) {
    swallow('telemetry.insert_failed', err);
    return false;
  }
}

/**
 * Aggregate telemetry rows for a single agent. Returns zeros (never null)
 * for an agent with no rows — a never-active agent's usage is genuinely 0.
 * @param {string} agentId
 */
export function sumTelemetryByAgent(agentId) {
  if (typeof agentId !== 'string' || agentId.length === 0) {
    return { requests: 0, tokens_in: 0, tokens_out: 0, total_cost_usd: 0 };
  }
  try {
    const r = getTelemetryStatements().sumByAgent.get(agentId);
    return {
      requests: r?.requests || 0,
      tokens_in: r?.tokens_in || 0,
      tokens_out: r?.tokens_out || 0,
      total_cost_usd: r?.total_cost_usd || 0,
    };
  } catch (err) {
    swallow('telemetry.sum_agent_failed', err);
    return { requests: 0, tokens_in: 0, tokens_out: 0, total_cost_usd: 0 };
  }
}

/**
 * Aggregate ALL telemetry rows (global rollup). Returns zeros (never null)
 * when the table is empty. Used by the gateway stats surface to fold
 * self-reported (non-proxy) usage into the dashboard's top-line cost /
 * token / request totals alongside proxy_logs. The two tables are disjoint
 * by design (migration 016: telemetry = calls that do NOT traverse the
 * proxy), so summing both is a union, not a double-count.
 * @returns {{ requests: number, tokens_in: number, tokens_out: number, total_cost_usd: number }}
 */
export function sumTelemetryAll() {
  try {
    const r = getTelemetryStatements().sumAll.get();
    return {
      requests: r?.requests || 0,
      tokens_in: r?.tokens_in || 0,
      tokens_out: r?.tokens_out || 0,
      total_cost_usd: r?.total_cost_usd || 0,
    };
  } catch (err) {
    swallow('telemetry.sum_all_failed', err);
    return { requests: 0, tokens_in: 0, tokens_out: 0, total_cost_usd: 0 };
  }
}

/**
 * Aggregate telemetry rows for a single project. Returns zeros for an
 * unknown / never-charged project.
 * @param {string} projectId
 */
export function sumTelemetryByProject(projectId) {
  if (typeof projectId !== 'string' || projectId.length === 0) {
    return { requests: 0, tokens_in: 0, tokens_out: 0, total_cost_usd: 0 };
  }
  try {
    const r = getTelemetryStatements().sumByProject.get(projectId);
    return {
      requests: r?.requests || 0,
      tokens_in: r?.tokens_in || 0,
      tokens_out: r?.tokens_out || 0,
      total_cost_usd: r?.total_cost_usd || 0,
    };
  } catch (err) {
    swallow('telemetry.sum_project_failed', err);
    return { requests: 0, tokens_in: 0, tokens_out: 0, total_cost_usd: 0 };
  }
}

const ZERO = Object.freeze({ requests: 0, tokens_in: 0, tokens_out: 0, total_cost_usd: 0 });

function normSum(r) {
  return {
    requests: r?.requests || 0,
    tokens_in: r?.tokens_in || 0,
    tokens_out: r?.tokens_out || 0,
    total_cost_usd: r?.total_cost_usd || 0,
  };
}

/**
 * Aggregate proxy_logs rows for a single agent. proxy_logs records calls that
 * flow THROUGH the gateway proxy — disjoint from telemetry by design.
 * @param {string} agentId
 */
export function sumProxyByAgent(agentId) {
  if (typeof agentId !== 'string' || agentId.length === 0) return { ...ZERO };
  try {
    return normSum(getTelemetryStatements().proxySumByAgent.get(agentId));
  } catch (err) {
    swallow('telemetry.proxy_sum_agent_failed', err);
    return { ...ZERO };
  }
}

/**
 * Aggregate proxy_logs rows for a single project.
 * @param {string} projectId
 */
export function sumProxyByProject(projectId) {
  if (typeof projectId !== 'string' || projectId.length === 0) return { ...ZERO };
  try {
    return normSum(getTelemetryStatements().proxySumByProject.get(projectId));
  } catch (err) {
    swallow('telemetry.proxy_sum_project_failed', err);
    return { ...ZERO };
  }
}

/**
 * Combined cost for a single agent = telemetry ∪ proxy_logs (disjoint sources,
 * so the sum is a union not a double-count). Returns the canonical cost
 * contract { requests, tokens_in, tokens_out, total_cost_usd }.
 * @param {string} agentId
 */
export function costForAgent(agentId) {
  const tel = sumTelemetryByAgent(agentId);
  const proxy = sumProxyByAgent(agentId);
  return {
    requests: tel.requests + proxy.requests,
    tokens_in: tel.tokens_in + proxy.tokens_in,
    tokens_out: tel.tokens_out + proxy.tokens_out,
    total_cost_usd: tel.total_cost_usd + proxy.total_cost_usd,
  };
}

/**
 * Aggregate telemetry rows for an agent across ALL its session slots —
 * matches the bare BASE id OR any `<base>-<slot>` id. `base` MUST already be
 * peeled (slot suffix removed) by the caller. See the proxySumByAgentBase /
 * sumByAgentBase SPECS for the slot-vs-base rationale.
 * @param {string} base
 */
export function sumTelemetryByAgentBase(base) {
  if (typeof base !== 'string' || base.length === 0) return { ...ZERO };
  try {
    return normSum(getTelemetryStatements().sumByAgentBase.get(base, base));
  } catch (err) {
    swallow('telemetry.sum_agent_base_failed', err);
    return { ...ZERO };
  }
}

/**
 * Aggregate proxy_logs rows for an agent across ALL its session slots —
 * matches the bare BASE id OR any `<base>-<slot>` id. `base` MUST already be
 * peeled by the caller.
 * @param {string} base
 */
export function sumProxyByAgentBase(base) {
  if (typeof base !== 'string' || base.length === 0) return { ...ZERO };
  try {
    return normSum(getTelemetryStatements().proxySumByAgentBase.get(base, base));
  } catch (err) {
    swallow('telemetry.proxy_sum_agent_base_failed', err);
    return { ...ZERO };
  }
}

/**
 * Combined cost for an agent across ALL its session slots = telemetry ∪
 * proxy_logs, rolled up by the agent's BASE id. This is the production-correct
 * "my cost": telemetry rows carry the session slot (`nova-2`) while proxy_logs
 * rows carry the base (`nova`), so a base-rollup is the only match that counts
 * BOTH. `base` MUST already be peeled by the caller (the cost tools peel the
 * configured id via normaliseBaseAgentId before calling).
 * @param {string} base
 */
export function costForAgentBase(base) {
  const tel = sumTelemetryByAgentBase(base);
  const proxy = sumProxyByAgentBase(base);
  return {
    requests: tel.requests + proxy.requests,
    tokens_in: tel.tokens_in + proxy.tokens_in,
    tokens_out: tel.tokens_out + proxy.tokens_out,
    total_cost_usd: tel.total_cost_usd + proxy.total_cost_usd,
  };
}

/**
 * Aggregate telemetry rows grouped by session slot (agent_id). Returns an
 * array of per-session rollups that the statsHandler folds into the
 * `usage_by_session` response map. Clone of sumByAgent but grouped — each
 * entry represents one session slot (e.g. `nova-2`). Returns [] (never
 * null) when the table is empty.
 *
 * @returns {Array<{
 *   session_id: string,
 *   requests: number,
 *   tokens_in: number,
 *   tokens_out: number,
 *   total_cost_usd: number,
 * }>}
 */
export function sumTelemetryBySession() {
  try {
    const rows = getTelemetryStatements().sumBySession.all();
    return rows.map((r) => ({
      session_id: r.session_id,
      requests: r.requests || 0,
      tokens_in: r.tokens_in || 0,
      tokens_out: r.tokens_out || 0,
      total_cost_usd: r.total_cost_usd || 0,
    }));
  } catch (err) {
    swallow('telemetry.sum_session_failed', err);
    return [];
  }
}

/**
 * Combined cost for a single project = telemetry ∪ proxy_logs.
 * @param {string} projectId
 */
export function costForProject(projectId) {
  const tel = sumTelemetryByProject(projectId);
  const proxy = sumProxyByProject(projectId);
  return {
    requests: tel.requests + proxy.requests,
    tokens_in: tel.tokens_in + proxy.tokens_in,
    tokens_out: tel.tokens_out + proxy.tokens_out,
    total_cost_usd: tel.total_cost_usd + proxy.total_cost_usd,
  };
}
