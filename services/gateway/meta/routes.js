/**
 * Gateway meta routes — PUBLIC (lean) variant.
 *
 * Identical to meta/routes.js minus the three kept→cut imports
 * (providers/registry, bridge/notifier, plugins/subscribers) and the
 * three fields they populated in systemHealthHandler (registry_state,
 * unreachable_agents, active_subscribers). fullHealthHandler is imported
 * from ./health-full.public.js (the bridge-free variant). The export
 * pipeline (Plan E) renames this file to routes.js.
 */

import { spawn } from 'node:child_process';
import { getCounters } from '@cortex/sdk/errors';
import { getDb } from '@cortex/sdk/db';
import { swallow } from '@cortex/sdk/errors';
import { isMatrixLoadFailed } from '../auth/index.js';
import { insertTelemetry, sumTelemetryAll, sumTelemetryBySession } from './telemetry.js';
import { fullHealthHandler } from './health-full.js';
import { TelemetryReportInputSchema } from '../mcp/tools/telemetry_report.js';
import pkg from '../package.json' with { type: 'json' };

function readCtxHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  if (Object.prototype.hasOwnProperty.call(headers, name)) return headers[name];
  const lower = name.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(headers, lower)) return headers[lower];
  return null;
}

const RESTART_DELAY_MS = 2000;
const SELF_TERMINATE_DELAY_MS = 500;
const RESTART_SPAWN_TIMEOUT_MS = 1000;
const CORTEX_HOME = process.env.CORTEX_HOME;
const TEARDOWN_SCRIPT = CORTEX_HOME ? `${CORTEX_HOME}/scripts/teardown-prod.sh` : null;
const RUN_SCRIPT = CORTEX_HOME ? `${CORTEX_HOME}/scripts/run-prod.sh` : null;

const LOG_PAGE_LIMIT = 200;

function ok(body, status = 200) {
  return { status, body };
}

function healthHandler(ctx) {
  const counters = getCounters();
  const { __lastErrors: lastErrors, ...sampled } = counters;
  const actor = ctx?.actor;
  const isAnon = !actor || actor.kind === 'anon';
  const body = {
    ok: true,
    ts: Date.now(),
    swallow_counters: sampled,
  };
  if (!isAnon) {
    body.swallow_last_errors = lastErrors || {};
  }
  return ok(body);
}

function statsHandler() {
  try {
    const db = getDb();
    const agentsCount = db.prepare('SELECT COUNT(*) AS n FROM agents').get()?.n ?? 0;
    const tasksCount = db.prepare('SELECT COUNT(*) AS n FROM tasks').get()?.n ?? 0;
    const pendingTasks = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status='pending'").get()?.n ?? 0;
    const activeAgents = db.prepare("SELECT COUNT(*) AS n FROM agents WHERE status='online'").get()?.n ?? 0;
    const eventsCount = db.prepare('SELECT COUNT(*) AS n FROM events').get()?.n ?? 0;

    const proxyAgg = db.prepare(
      `SELECT
         COUNT(*)                      AS requests,
         COALESCE(SUM(input_tokens), 0)  AS tokens_in,
         COALESCE(SUM(output_tokens), 0) AS tokens_out,
         COALESCE(SUM(cost_usd), 0)      AS total_cost_usd
       FROM proxy_logs`,
    ).get() || {};
    const tel = sumTelemetryAll();

    const sessionRows = sumTelemetryBySession();
    const requests_by_agent = {};
    const usage_by_session = {};
    for (const row of sessionRows) {
      requests_by_agent[row.session_id] = row.requests;
      usage_by_session[row.session_id] = {
        requests: row.requests,
        tokens_in: row.tokens_in,
        tokens_out: row.tokens_out,
        total_cost_usd: row.total_cost_usd,
      };
    }

    return ok({
      agents: { total: agentsCount, active: activeAgents },
      tasks: { total: tasksCount, pending: pendingTasks },
      events: { total: eventsCount },
      total_requests: (proxyAgg.requests || 0) + tel.requests,
      total_tokens_in: (proxyAgg.tokens_in || 0) + tel.tokens_in,
      total_tokens_out: (proxyAgg.tokens_out || 0) + tel.tokens_out,
      total_cost_usd: (proxyAgg.total_cost_usd || 0) + tel.total_cost_usd,
      requests_by_agent,
      usage_by_session,
      generated_at: Date.now(),
    });
  } catch (err) {
    swallow('meta.stats_query_failed', err);
    return { status: 500, body: { error: 'stats_query_failed', message: err?.message || 'db error' } };
  }
}

function logsHandler(ctx) {
  const limit = Math.min(Math.max(1, Number.parseInt(ctx?.query?.limit, 10) || 50), LOG_PAGE_LIMIT);
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT id, agent_id, project_id, method, path, status,
              model, cost_usd, input_tokens, output_tokens,
              duration_ms, created_at
       FROM proxy_logs
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(limit);
    return ok({ logs: rows, count: rows.length });
  } catch (err) {
    swallow('meta.logs_query_failed', err);
    return { status: 500, body: { error: 'logs_query_failed', message: err?.message || 'db error' } };
  }
}

function telemetryIngestHandler(ctx) {
  const body = ctx?.body;
  if (body == null || typeof body !== 'object') {
    return { status: 400, body: { error: 'invalid_body', reason: 'body must be a JSON object' } };
  }
  const actor = ctx?.actor;
  if (!actor || actor.kind === 'anon') {
    return { status: 401, body: { error: 'unauthorized', reason: 'authentication required for telemetry ingest' } };
  }
  const parsed = TelemetryReportInputSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, body: { error: 'invalid_telemetry', issues: parsed.error.issues } };
  }
  const facts = parsed.data;

  const base = actor.base ?? actor.id ?? null;
  const sessionHeader = readCtxHeader(ctx?.headers, 'x-cortex-session');
  let agentId = base;
  if (typeof sessionHeader === 'string' && sessionHeader.length > 0 && typeof base === 'string') {
    if (sessionHeader === base || sessionHeader.startsWith(`${base}-`)) {
      agentId = sessionHeader;
    }
  }

  try {
    const persisted = insertTelemetry({
      agent_id: agentId,
      project_id: body.project_id ?? null,
      method: facts.method,
      endpoint: facts.endpoint,
      model: facts.model,
      provider: facts.provider,
      tokens_in: facts.tokens_in,
      tokens_out: facts.tokens_out,
      cost_usd: facts.cost_usd,
      latency_ms: facts.latency_ms,
    });
    if (!persisted) {
      return { status: 500, body: { error: 'telemetry_persist_failed' } };
    }
    return ok({ ok: true, recorded: true, agent_id: agentId }, 201);
  } catch (err) {
    swallow('meta.telemetry_ingest_failed', err);
    return { status: 500, body: { error: 'telemetry_persist_failed', message: err?.message || 'db error' } };
  }
}

const _reaperSweepState = { ts: null, marked: 0 };

export function recordReaperSweep({ ts, marked }) {
  _reaperSweepState.ts = ts;
  _reaperSweepState.marked = marked;
}

function systemHealthHandler() {
  const counters = getCounters();
  const { __lastErrors: _lastErrors, ...swallowCounters } = counters;

  let dbPath = null;
  try {
    dbPath = getDb()?.name ?? null;
  } catch (_err) {
    // DB not yet ready — tolerate gracefully
  }

  return ok({
    uptime_seconds: process.uptime(),
    version: pkg.version,
    swallow_counters: swallowCounters,
    last_reaper_sweep: {
      ts: _reaperSweepState.ts,
      marked: _reaperSweepState.marked,
    },
    db_path: dbPath,
    gateway_pid: process.pid,
    // F-04: surface matrix load status so operators and CI can detect RBAC
    // failures without attaching a debugger or tailing logs.
    matrix_loaded: !isMatrixLoadFailed(),
  });
}

function waitForChildSpawn(child, timeoutMs) {
  if (!child || typeof child.once !== 'function') return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (typeof child.off === 'function') {
        child.off('spawn', onSpawn);
        child.off('error', onError);
      }
    };
    const settle = (err = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve();
    };
    const onSpawn = () => settle();
    const onError = (err) => settle(err || new Error('restart child spawn failed'));

    child.once('spawn', onSpawn);
    child.once('error', onError);
    timer = setTimeout(() => {
      settle(new Error('restart child spawn timeout'));
    }, timeoutMs);
  });
}

export function createRestartHandler({
  spawn: spawnImpl = spawn,
  kill: killImpl = (pid, signal) => process.kill(pid, signal),
  setTimeout: setTimeoutImpl = setTimeout,
  restartDelayMs = RESTART_DELAY_MS,
  selfTerminateDelayMs = SELF_TERMINATE_DELAY_MS,
  spawnTimeoutMs = RESTART_SPAWN_TIMEOUT_MS,
  teardownScript = TEARDOWN_SCRIPT,
  runScript = RUN_SCRIPT,
} = {}) {
  return async function restartHandler(ctx) {
    if (!ctx.actor || ctx.actor.kind === 'anon') {
      return { status: 401, body: { error: 'unauthorized', reason: 'authentication required' } };
    }

    const requestedBy = ctx.actor.id ?? ctx.actor.base ?? ctx.actor.kind;
    console.log(`[system] restart requested by agent=${requestedBy} pid=${process.pid} ts=${new Date().toISOString()}`);

    const cmd = `sleep 2; ${teardownScript}; exec ${runScript}`;
    let child = null;
    try {
      child = spawnImpl('bash', ['-c', cmd], {
        detached: true,
        stdio: 'ignore',
      });
      await waitForChildSpawn(child, spawnTimeoutMs);
    } catch (err) {
      swallow('meta.restart_spawn_failed', err);
      return {
        status: 500,
        body: {
          error: 'restart_spawn_failed',
          message: err?.message || 'restart child failed to spawn',
        },
      };
    }

    if (typeof child?.unref === 'function') child.unref();

    setTimeoutImpl(() => {
      console.log(`[system] gateway self-terminating for restart (requested_by=${requestedBy})`);
      killImpl(process.pid, 'SIGTERM');
    }, selfTerminateDelayMs);

    return {
      status: 202,
      body: { ok: true, requested_by: requestedBy, restart_in_ms: restartDelayMs },
    };
  };
}

const restartHandler = createRestartHandler();

export function mountMetaRoutes(adapter) {
  if (!adapter || typeof adapter.add !== 'function') {
    throw new Error('mountMetaRoutes: adapter must expose add(method, path, handler)');
  }
  adapter.add('GET', '/v1/api/health', healthHandler);
  adapter.add('GET', '/v1/api/health/full', fullHealthHandler);
  adapter.add('GET', '/v1/api/system/health', systemHealthHandler);
  adapter.add('GET', '/health', healthHandler);
  adapter.add('GET', '/v1/api/stats', statsHandler);
  adapter.add('GET', '/v1/api/gateway/logs', logsHandler);
  adapter.add('POST', '/api/gateway/telemetry', telemetryIngestHandler);
  adapter.add('POST', '/v1/api/gateway/telemetry', telemetryIngestHandler);
  adapter.add('POST', '/v1/api/system/restart', restartHandler);
}
