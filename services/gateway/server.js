/**
 * Cortex Gateway — API proxy, bot registration, heartbeat, task dispatch, cost metering.
 *
 * Route modules handle domain logic. This file:
 *   1. Load config + init DB + init auth
 *   2. Mount route handlers
 *   3. Auth middleware (token validation, identity derivation, path reconciliation)
 *   4. Mount API proxy (Anthropic, OpenAI, OpenRouter, Ollama)
 *   5. Data-scoped API routes
 *   6. Start the server with WebSocket support
 */
import { initDb, getDb, getStmts, jsonParse, genId } from './lib/db.js';
import { handleProxy, isProxyRoute, matchRoute, queryLogs, queryLogStats, addWsClient, removeWsClient } from './lib/proxy.js';
import { handleOtlpHttpLogs } from './lib/otel.js';
import { initAuth, authenticateRequest, identifyAgent, isAdmin, reconcilePathIdentity, requiresAuth } from './lib/auth.js';
import { createMCPHandler } from './mcp/server.js';
import { checkAuthFailRate, checkAgentRate } from './lib/rate-limit.js';
import { mkdirSync, existsSync, rmSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { slugify, resolveWorkspaceRoot, writePhaseReadme, syncTaskFileLifecycle, findTaskFolderByUuid } from './lib/task-files.js';

// --- Config ---
const dataDir = process.env.CORTEX_GATEWAY_DB
  ? path.dirname(process.env.CORTEX_GATEWAY_DB)
  : path.join(process.env.HOME || '.', '.cortex', 'data');

const HOST = process.env.CORTEX_GATEWAY_HOST || '127.0.0.1';
const PORT = (() => {
  const p = Number(process.env.CORTEX_GATEWAY_PORT || 4840);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    console.error(`[gateway] FATAL: invalid port ${process.env.CORTEX_GATEWAY_PORT}. Must be 1-65535.`);
    process.exit(1);
  }
  return p;
})();
const DB_PATH = process.env.CORTEX_GATEWAY_DB || path.join(dataDir, 'gateway.db');
const HARDENED = process.env.CORTEX_MODE === 'hardened';
const REGISTRY_PATH = process.env.CORTEX_TOKEN_REGISTRY || path.join(dataDir, 'token-registry.json');
const CORS_ORIGIN = process.env.CORTEX_CORS_ORIGIN || null; // null = same-origin only
const MAX_BODY_BYTES = Number(process.env.CORTEX_MAX_BODY_BYTES) || 1_048_576; // 1 MB default
const MAX_WS_PER_AGENT = Number(process.env.CORTEX_MAX_WS_PER_AGENT) || 10;

mkdirSync(dataDir, { recursive: true });

// --- Init DB + auth + route modules ---
const { db, stmts } = initDb(DB_PATH);
initAuth();

import tasksRoutes from './routes/tasks.js';
import modelRoutes from './routes/model.js';
import serviceRoutes from './routes/services.js';
import statsRoutes from './routes/stats.js';
import cortexTasksRoutes from './routes/cortex-tasks.js';

const tasks = tasksRoutes();
const models = modelRoutes();
const services = serviceRoutes();
const stats = statsRoutes();
const cortexTasks = cortexTasksRoutes();

// Gateway context passed to MCP handlers
const gateway = { db, stmts, models, config: { host: HOST, port: PORT } };
const handleMCP = createMCPHandler(gateway, { identifyAgent });

// ---------------------------------------------------------------------------
// Data scoping helpers — filter responses by server-derived agent identity
// ---------------------------------------------------------------------------

function scopeTasks(tasksList, identity) {
  if (!identity) return [];
  const id = identity.toLowerCase();
  return tasksList.filter(t => (t.assigned_agent || '').toLowerCase() === id || (t.assigned_platform || '').toLowerCase() === id);
}

function isoFromUnix(ts) {
  if (!ts) return null;
  return new Date(Number(ts) * 1000).toISOString();
}

function loadTokenRegistry() {
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  } catch {
    return { agents: {} };
  }
}

function saveTokenRegistry(registry) {
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
}

function generateAgentToken(name) {
  const raw = `cortex_${name}_${randomBytes(32).toString('hex')}`;
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

// --- CORS helper ---
function addCorsHeaders(headers = {}) {
  const origin = CORS_ORIGIN || 'null'; // 'null' disallows cross-origin when no origin configured
  return {
    ...headers,
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Cortex-Token, X-Cortex-Agent-Id, Authorization, X-Api-Key',
  };
}

// --- WebSocket connection tracking per agent (BUG-25) ---
const wsConnectionsPerAgent = new Map(); // agent -> count

// --- Port validation (BUG-18/19) ---
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`[gateway] FATAL: invalid port ${PORT} — must be an integer between 1 and 65535`);
  process.exit(1);
}

// --- HTTP Server with WebSocket ---
let server;
try {
server = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req, server) {
   try {
    const url = new URL(req.url);
    const method = req.method;
    const p = url.pathname;

    // --- CORS preflight (BUG-10) ---
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: addCorsHeaders() });
    }

    // --- Duplicate X-Cortex-Token header check (BUG-07) ---
    // Bun joins duplicate headers with ', ' in .get(). Also check .getAll() if available.
    const rawToken = req.headers.get('x-cortex-token');
    if (rawToken && rawToken.includes(',')) {
      return Response.json(
        { error: 'bad_request', message: 'Duplicate X-Cortex-Token headers are not allowed' },
        { status: 400, headers: addCorsHeaders() },
      );
    }

    // --- HTTP body size limit (BUG-28) ---
    // Check Content-Length header first, then enforce on actual body read
    const contentLength = req.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
      return Response.json(
        { error: 'payload_too_large', message: `Content-Length exceeds ${MAX_BODY_BYTES} byte limit` },
        { status: 413, headers: addCorsHeaders() },
      );
    }
    // Safe JSON parser that enforces size on actual body (handles chunked/no-length)
    const safeJson = async (r) => {
      const raw = await r.text();
      const byteLength = new TextEncoder().encode(raw).byteLength;
      if (byteLength > MAX_BODY_BYTES) throw Object.assign(new Error('payload_too_large'), { status: 413 });
      return JSON.parse(raw);
    };

    // --- Rate limiting (BUG-08/11) ---
    const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      || server?.requestIP?.(req)?.address
      || 'unknown';

    // --- WebSocket upgrade for live traffic feed (auth required) ---
    if (p === '/ws/gateway' && req.headers.get('upgrade') === 'websocket') {
      const wsToken = req.headers.get('x-cortex-token') || url.searchParams.get('token');
      if (!wsToken) return Response.json({ error: 'unauthorized', message: 'token required for WebSocket' }, { status: 401 });
      const wsIdentity = identifyAgent({ headers: { get: (h) => h === 'x-cortex-token' ? wsToken : null } });
      if (!wsIdentity) return Response.json({ error: 'unauthorized', message: 'invalid token' }, { status: 401, headers: addCorsHeaders() });
      // --- WebSocket connection limit per agent (BUG-25) ---
      const currentWsCount = wsConnectionsPerAgent.get(wsIdentity) || 0;
      if (currentWsCount >= MAX_WS_PER_AGENT) {
        return Response.json(
          { error: 'too_many_connections', message: `WebSocket limit of ${MAX_WS_PER_AGENT} connections per agent reached` },
          { status: 429, headers: addCorsHeaders() },
        );
      }
      const ok = server.upgrade(req, { data: { identity: wsIdentity } });
      if (ok) return undefined;
      return new Response('WebSocket upgrade failed', { status: 500 });
    }

    // --- Health (BUG-39: no sensitive details without auth) ---
    if (p === '/health') {
      const healthIdentity = identifyAgent(req);
      if (!healthIdentity) {
        return Response.json({ status: 'ok' }, { headers: addCorsHeaders() });
      }
      return Response.json({ status: 'ok', service: 'gateway', uptime: process.uptime() }, { headers: addCorsHeaders() });
    }

    // ==================== Auth Middleware ====================
    // Identify agent from token on ALL requests. Required for API + MCP routes.

    const agentIdentity = identifyAgent(req);
    const adminAccess = isAdmin(agentIdentity);
    req._cortexIdentity = agentIdentity;

    // --- OTLP on main gateway port ---
    if (p === '/v1/logs' && method === 'POST') {
      return handleOtlpHttpLogs(req, stmts, { sourceAgent: agentIdentity || 'unknown', provider: 'unknown' });
    }

    // ==================== API Proxy Routes ====================
    // Proxy routes require Cortex token when using managed credentials.
    // Passthrough (caller sends own auth) works without Cortex token.

    if (isProxyRoute(p)) {
      const routeMatch = matchRoute(p);
      const requestedAgentHeader = req.headers.get('x-cortex-agent-id');
      const requestedAgentIdentity = routeMatch?.pathAgentId || requestedAgentHeader;

      // Explicit agent attribution is only allowed when backed by a valid Cortex token.
      if (requestedAgentIdentity && !agentIdentity) {
        return Response.json({
          error: 'unauthorized',
          message: 'Cortex token required for explicit agent attribution',
        }, { status: 401 });
      }

      // Path-vs-token reconciliation
      if (routeMatch && routeMatch.pathAgentId && agentIdentity) {
        if (!reconcilePathIdentity(routeMatch.pathAgentId, agentIdentity)) {
          return Response.json({
            error: 'identity_mismatch',
            message: `Path agent '${routeMatch.pathAgentId}' does not match token identity '${agentIdentity}'`,
          }, { status: 403 });
        }
      }

      // Block managed-mode proxy without a valid Cortex token
      const hasCallerAuth = req.headers.get('authorization') || req.headers.get('x-api-key');
      if (!hasCallerAuth && !agentIdentity) {
        return Response.json({ error: 'unauthorized', message: 'Cortex token required for managed proxy mode' }, { status: 401 });
      }

      const proxyRes = await handleProxy(req);
      if (proxyRes) return proxyRes;
    }

    // ==================== Auth Gate for API + MCP Routes ====================
    // Agent identity is always required — free and hardened tier.

    if (requiresAuth(p, method)) {
      if (!agentIdentity) {
        // BUG-08/11: Rate-limit auth failures per IP
        if (checkAuthFailRate(clientIp)) {
          return Response.json(
            { error: 'rate_limited', message: 'Too many authentication failures. Try again later.' },
            { status: 429, headers: addCorsHeaders() },
          );
        }
        const { error } = authenticateRequest(req);
        return Response.json({ error: 'unauthorized', message: error }, { status: 401 });
      }
    }

    // BUG-08/11: Rate-limit normal operations per agent (admin exempt — dashboard polls frequently)
    if (agentIdentity && !adminAccess && checkAgentRate(agentIdentity)) {
      return Response.json(
        { error: 'rate_limited', message: 'Too many requests. Try again later.' },
        { status: 429, headers: addCorsHeaders() },
      );
    }

    // --- Auto-active: touch agent on every authenticated request ---
    if (agentIdentity) {
      try { stmts.touchAgent.run(agentIdentity, agentIdentity); } catch { /* best effort */ }
    }

    // --- MCP (after auth gate) ---
    if (p === '/mcp' || p.startsWith('/mcp/')) {
      return handleMCP(req);
    }

    if (p === '/api/health' && method === 'GET') {
      const r = cortexTasks.health();
      return Response.json(r.body, { status: r.status });
    }

    if (p === '/api/agents/heartbeat' && method === 'POST') {
      let body;
      try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
      const r = cortexTasks.heartbeat(body, { agentIdentity });
      return Response.json(r.body, { status: r.status });
    }

    if (p === '/api/agents' && method === 'GET') {
      const r = cortexTasks.agentStatus(null);
      return Response.json(r.body, { status: r.status });
    }

    const apiAgentMatch = p.match(/^\/api\/agents\/([^/]+)$/);
    if (apiAgentMatch && method === 'GET') {
      const r = cortexTasks.agentStatus(apiAgentMatch[1]);
      return Response.json(r.body, { status: r.status });
    }

    if (p === '/api/agents/register' && method === 'POST') {
      if (!adminAccess) {
        return Response.json({ error: 'admin access required' }, { status: 403 });
      }
      let body;
      try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
      if (!body.name || !body.platform) {
        return Response.json({ error: 'name and platform are required' }, { status: 400 });
      }
      const registry = loadTokenRegistry();
      if (registry.agents[body.name]) {
        return Response.json({ error: 'agent already exists' }, { status: 409 });
      }
      const { raw, hash } = generateAgentToken(body.name);
      // BUG-30: Reject if the new token's hash collides with any existing agent's hash
      for (const [existingAgent, cfg] of Object.entries(registry.agents)) {
        if (cfg.hash === hash) {
          return Response.json({ error: 'token hash collision — please retry registration' }, { status: 409 });
        }
      }
      registry.agents[body.name] = {
        hash,
        platform: body.platform,
        model: body.model || null,
        provider: body.provider || null,
        created: new Date().toISOString(),
      };
      saveTokenRegistry(registry);
      stmts.touchAgent.run(body.name, body.name);
      broadcastLog({
        type: 'agent:registered',
        data: {
          agent_id: body.name,
          platform: body.platform,
          registered_at: new Date().toISOString(),
        },
      });
      return Response.json({
        agent_id: body.name,
        token: raw,
        warning: 'Save this token now. It will NOT be shown again.',
        next_step_hint: 'Configure agent to send X-Cortex-Token with this value.',
      }, { status: 201 });
    }

    // ==================== Gateway Log Routes (scoped) ====================

    if (p === '/api/gateway/logs' && method === 'GET') {
      const model = url.searchParams.get('model');
      const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') || 100)), 1000);

      if (!adminAccess) {
        // Agents only see their own logs
        const logs = queryLogs({ agentId: agentIdentity, model, limit });
        return Response.json({ ok: true, logs });
      }

      // Admin access can query broader slices explicitly.
      const agentId = url.searchParams.get('agent_id');
      const projectId = url.searchParams.get('project_id');
      const logs = queryLogs({ agentId, projectId, model, limit });
      return Response.json({ ok: true, logs });
    }

    if (p === '/api/gateway/logs/stats' && method === 'GET') {
      // Stats are aggregate — non-admin callers only see their own activity.
      if (!adminAccess) {
        // Return agent-scoped stats only
        const logs = queryLogs({ agentId: agentIdentity, limit: 1000 });
        const totalCost = logs.reduce((s, l) => s + (l.cost_usd || 0), 0);
        const totalIn = logs.reduce((s, l) => s + (l.tokens_in || 0), 0);
        const totalOut = logs.reduce((s, l) => s + (l.tokens_out || 0), 0);
        const avgLatency = logs.length ? logs.reduce((s, l) => s + (l.latency_ms || 0), 0) / logs.length : 0;
        return Response.json({
          ok: true,
          stats: {
            overall: { total_requests: logs.length, total_cost: totalCost, total_tokens_in: totalIn, total_tokens_out: totalOut, avg_latency_ms: avgLatency },
            agent: agentIdentity,
          },
        });
      }

      const logStats = queryLogStats();
      return Response.json({ ok: true, stats: logStats });
    }

    if (p === '/api/stats' && method === 'GET') {
      const period = url.searchParams.get('period') || 'today';
      const logs = adminAccess ? queryLogs({ limit: 5000 }) : queryLogs({ agentId: agentIdentity, limit: 5000 });
      const totalRequests = logs.length;
      const totalTokensIn = logs.reduce((sum, row) => sum + (row.tokens_in || 0), 0);
      const totalTokensOut = logs.reduce((sum, row) => sum + (row.tokens_out || 0), 0);
      const totalCostUsd = logs.reduce((sum, row) => sum + (row.cost_usd || 0), 0);
      const avgLatencyMs = totalRequests ? logs.reduce((sum, row) => sum + (row.latency_ms || 0), 0) / totalRequests : 0;
      const errors = logs.filter((row) => (row.status_code || 0) >= 400).length;
      const requestsByAgent = {};
      const requestsByProvider = {};
      for (const row of logs) {
        const aid = row.agent_id || 'unknown';
        if (!requestsByAgent[aid]) requestsByAgent[aid] = { count: 0, cost: 0, tokens: 0, errors: 0, avg_latency: 0, _totalLatency: 0 };
        requestsByAgent[aid].count += 1;
        requestsByAgent[aid].cost += (row.cost_usd || 0);
        requestsByAgent[aid].tokens += (row.tokens_in || 0) + (row.tokens_out || 0);
        requestsByAgent[aid]._totalLatency += (row.latency_ms || 0);
        if ((row.status_code || 0) >= 400) requestsByAgent[aid].errors += 1;
        requestsByProvider[row.provider || 'unknown'] = (requestsByProvider[row.provider || 'unknown'] || 0) + 1;
      }
      for (const aid of Object.keys(requestsByAgent)) {
        const a = requestsByAgent[aid];
        a.avg_latency = a.count ? a._totalLatency / a.count : 0;
        delete a._totalLatency;
      }
      // Quality metrics per agent from task data
      const qualityRows = db.prepare(`
        SELECT assigned_agent,
          COUNT(*) as total_tasks,
          SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as approved,
          SUM(COALESCE(rejection_count, 0)) as total_rejections
        FROM cortex_tasks WHERE assigned_agent IS NOT NULL
        GROUP BY assigned_agent
      `).all();
      for (const row of qualityRows) {
        const aid = row.assigned_agent;
        if (!requestsByAgent[aid]) requestsByAgent[aid] = { count: 0, cost: 0, tokens: 0, errors: 0, avg_latency: 0 };
        requestsByAgent[aid].total_tasks = row.total_tasks;
        requestsByAgent[aid].approved = row.approved;
        requestsByAgent[aid].total_rejections = row.total_rejections;
        requestsByAgent[aid].error_rate = (row.total_rejections + row.approved) > 0
          ? row.total_rejections / (row.total_rejections + row.approved) : 0;
      }
      return Response.json({
        period,
        total_requests: totalRequests,
        total_tokens_in: totalTokensIn,
        total_tokens_out: totalTokensOut,
        total_cost_usd: totalCostUsd,
        requests_by_agent: requestsByAgent,
        requests_by_provider: requestsByProvider,
        error_rate: totalRequests ? errors / totalRequests : 0,
        avg_latency_ms: avgLatencyMs,
        next_step_hint: 'Stats retrieved.',
      });
    }

    const costMatch = p.match(/^\/api\/costs\/([^/]+)$/);
    if (costMatch && method === 'GET') {
      const targetAgent = costMatch[1];
      if (!adminAccess && targetAgent !== agentIdentity) {
        return Response.json({ error: 'forbidden' }, { status: 403 });
      }
      const period = url.searchParams.get('period') || 'today';
      const taskId = url.searchParams.get('task_id');
      let logs = queryLogs({ agentId: targetAgent, limit: 5000 });
      if (taskId) logs = logs.filter((row) => row.project_id === taskId || row.request_id === taskId);
      return Response.json({
        agent_id: targetAgent,
        period,
        tokens_in: logs.reduce((sum, row) => sum + (row.tokens_in || 0), 0),
        tokens_out: logs.reduce((sum, row) => sum + (row.tokens_out || 0), 0),
        total_cost_usd: logs.reduce((sum, row) => sum + (row.cost_usd || 0), 0),
        request_count: logs.length,
        avg_latency_ms: logs.length ? logs.reduce((sum, row) => sum + (row.latency_ms || 0), 0) / logs.length : 0,
        cost_by_model: logs.reduce((acc, row) => {
          const key = row.model || 'unknown';
          if (!acc[key]) acc[key] = { requests: 0, cost: 0 };
          acc[key].requests += 1;
          acc[key].cost += row.cost_usd || 0;
          return acc;
        }, {}),
        next_step_hint: 'Cost summary retrieved.',
      });
    }

    if (p === '/api/errors' && method === 'GET') {
      const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') || 10)), 100);
      const since = url.searchParams.get('since');
      let logs = queryLogs({ agentId: agentIdentity, limit: 1000 }).filter((row) => (row.status_code || 0) >= 400 || row.error);
      if (since) logs = logs.filter((row) => row.timestamp >= since);
      logs = logs.slice(0, limit);
      return Response.json({
        errors: logs.map((row) => ({
          timestamp: row.timestamp,
          error_type: row.error ? 'gateway_error' : 'http_error',
          endpoint: row.path,
          error_message: row.error || `HTTP ${row.status_code}`,
          related_task_id: null,
        })),
        total: logs.length,
        next_step_hint: 'Error history retrieved.',
      });
    }

    if (p === '/api/bridge/send' && method === 'POST') {
      let body;
      try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
      const r = cortexTasks.bridgeSend(body, { agentIdentity });
      return Response.json(r.body, { status: r.status });
    }

    if (p === '/api/bridge/inbox' && method === 'GET') {
      if (!adminAccess) {
        return Response.json({ error: 'admin access required' }, { status: 403 });
      }
      const targetAgent = url.searchParams.get('agent');
      const r = cortexTasks.bridgeInbox(targetAgent, {
        unread_only: url.searchParams.get('unread_only'),
        mark_read: targetAgent ? url.searchParams.get('mark_read') : 'false',
        limit: url.searchParams.get('limit'),
      });
      return Response.json(r.body, { status: r.status });
    }

    const bridgeInboxMatch = p.match(/^\/api\/bridge\/inbox\/([^/]+)$/);
    if (bridgeInboxMatch && method === 'GET') {
      const targetAgent = bridgeInboxMatch[1];
      if (!adminAccess && targetAgent !== agentIdentity) {
        return Response.json({ error: 'forbidden' }, { status: 403 });
      }
      const r = cortexTasks.bridgeInbox(targetAgent, {
        unread_only: url.searchParams.get('unread_only'),
        mark_read: url.searchParams.get('mark_read'),
        limit: url.searchParams.get('limit'),
      });
      // summary_only: strip message bodies to save tokens
      if (url.searchParams.get('summary_only') === 'true' && r.body?.messages) {
        r.body.messages = r.body.messages.map(m => ({
          message_id: m.message_id, from: m.from, to: m.to,
          type: m.type || m.message_type, subject: m.subject,
          task_id: m.task_id, sent_at: m.sent_at, blocking: m.blocking,
        }));
      }
      return Response.json(r.body, { status: r.status });
    }

    const bridgeReplyMatch = p.match(/^\/api\/bridge\/reply\/([^/]+)$/);
    if (bridgeReplyMatch && method === 'POST') {
      let body;
      try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
      const r = cortexTasks.bridgeReply(bridgeReplyMatch[1], body, { agentIdentity });
      return Response.json(r.body, { status: r.status });
    }

    // Bridge ack — POST /api/bridge/ack/:messageId or POST /api/bridge/ack with body
    const bridgeAckMatch = p.match(/^\/api\/bridge\/ack\/([^/]+)$/);
    if (bridgeAckMatch && method === 'POST') {
      const r = cortexTasks.bridgeAck(bridgeAckMatch[1], { agentIdentity });
      return Response.json(r.body, { status: r.status });
    }
    if (p === '/api/bridge/ack' && method === 'POST') {
      let body;
      try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
      const r = cortexTasks.bridgeAck(body.message_id, { agentIdentity });
      return Response.json(r.body, { status: r.status });
    }

    if (p === '/api/projects' && method === 'POST') {
      let body;
      try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
      if (!body.name) return Response.json({ error: 'name is required' }, { status: 400 });
      const projectId = genId();
      const slug = slugify(body.name);
      // Check slug uniqueness
      if (stmts.getProjectBySlug.get(slug)) {
        return Response.json({ error: `project with slug '${slug}' already exists` }, { status: 409 });
      }
      const defaultReviewer = body.default_reviewer || body.reviewer || null;
      stmts.createProject.run(projectId, body.name, slug, body.description || null, 1, agentIdentity, defaultReviewer);
      // Create project folder + phase-1 + PHASE-README.md
      try {
        writePhaseReadme(slug, 1, body.description || null);
      } catch (err) {
        console.error(`[projects] folder creation warning: ${err.message}`);
      }
      return Response.json({
        id: projectId,
        name: body.name,
        slug,
        status: 'active',
        phase_count: 1,
        default_reviewer: defaultReviewer,
        created_at: new Date().toISOString(),
        next_step_hint: 'Project created with phase-1. Use task_create with project_id and phase_number to add tasks.',
      }, { status: 201 });
    }

    if (p === '/api/projects' && method === 'GET') {
      const projects = stmts.listProjects.all().map((project) => {
        const counts = stmts.projectTaskCounts.get(project.id) || {};
        const cost = stmts.projectCostSummary.get(project.id) || {};
        return {
          id: project.id,
          name: project.name,
          status: project.status,
          task_count: counts.task_count || 0,
          completed_count: counts.completed_count || 0,
          in_progress_count: counts.in_progress_count || 0,
          total_cost_usd: cost.total_cost_usd || 0,
          created_at: isoFromUnix(project.created_at),
        };
      });
      return Response.json({ projects, total: projects.length, next_step_hint: 'Use project_get for full detail.' });
    }

    // POST /api/projects/:id/phases — add a new phase
    const phasesPostMatch = p.match(/^\/api\/projects\/([^/]+)\/phases$/);
    if (phasesPostMatch && method === 'POST') {
      const projectId = phasesPostMatch[1];
      const project = stmts.getProject.get(projectId);
      if (!project) return Response.json({ error: 'project not found' }, { status: 404 });
      const newPhaseNumber = (project.phase_count ?? 0) + 1;
      stmts.updateProjectPhaseCount.run(newPhaseNumber, projectId);
      try {
        writePhaseReadme(project.slug, newPhaseNumber, null);
      } catch (err) {
        console.error(`[projects] phase folder creation warning: ${err.message}`);
      }
      return Response.json({
        project_id: projectId,
        phase_number: newPhaseNumber,
        phase_count: newPhaseNumber,
        next_step_hint: `Phase ${newPhaseNumber} added. Use task_create with phase_number=${newPhaseNumber} to add tasks.`,
      }, { status: 201 });
    }

    // GET /api/projects/:id/phases — list phases with completion status
    if (phasesPostMatch && method === 'GET') {
      const projectId = phasesPostMatch[1];
      const project = stmts.getProject.get(projectId);
      if (!project) return Response.json({ error: 'project not found' }, { status: 404 });
      const phases = [];
      const phaseCount = project.phase_count ?? 1;
      for (let i = 1; i <= phaseCount; i++) {
        const approved = stmts.countApprovedInPhase.get(projectId, i)?.count || 0;
        const total = stmts.countTasksInPhase.get(projectId, i)?.count || 0;
        phases.push({
          phase_number: i,
          task_count: total,
          approved_count: approved,
          complete: total > 0 && approved === total,
        });
      }
      return Response.json({ project_id: projectId, phases, next_step_hint: 'Phase list retrieved.' });
    }

    // DELETE /api/projects/:id/phases/:number — admin only, delete phase + tasks + folder
    const phaseDeleteMatch = p.match(/^\/api\/projects\/([^/]+)\/phases\/(\d+)$/);
    if (phaseDeleteMatch && method === 'DELETE') {
      if (!adminAccess) {
        return Response.json({ error: 'forbidden', message: 'admin token required' }, { status: 403 });
      }
      const projectId = phaseDeleteMatch[1];
      const phaseNumber = Number(phaseDeleteMatch[2]);
      const project = stmts.getProject.get(projectId);
      if (!project) return Response.json({ error: 'project not found' }, { status: 404 });

      // Delete task-related records, then tasks, then update phase count — atomic
      const taskIds = db.prepare(`SELECT id FROM cortex_tasks WHERE project_id = ? AND phase_number = ?`).all(projectId, phaseNumber).map(r => r.id);
      const newCount = Math.max(0, (project.phase_count ?? 1) - 1);
      const deletedTasks = db.transaction(() => {
        for (const tid of taskIds) {
          db.prepare(`DELETE FROM progress_reports WHERE task_id = ?`).run(tid);
          db.prepare(`DELETE FROM task_comments WHERE task_id = ?`).run(tid);
          db.prepare(`DELETE FROM task_rejections WHERE task_id = ?`).run(tid);
          db.prepare(`DELETE FROM audit_log WHERE task_id = ?`).run(tid);
        }
        const result = db.prepare(`DELETE FROM cortex_tasks WHERE project_id = ? AND phase_number = ?`).run(projectId, phaseNumber);
        stmts.updateProjectPhaseCount.run(newCount, projectId);
        return result;
      })();

      // Remove phase folder from workspace
      let folderRemoved = false;
      if (project.slug) {

        const root = resolveWorkspaceRoot();
        for (const projSuffix of ['', ' (finished)']) {
          const projectDir = path.join(root, project.slug + projSuffix);
          if (!existsSync(projectDir)) continue;
          for (const phaseSuffix of ['', ' (finished)']) {
            const phaseDir = path.join(projectDir, 'tasks', `phase-${phaseNumber}${phaseSuffix}`);
            if (existsSync(phaseDir)) {
              try { rmSync(phaseDir, { recursive: true, force: true }); folderRemoved = true; } catch { /* best effort */ }
            }
          }
        }
      }

      return Response.json({
        deleted: true,
        project_id: projectId,
        phase_number: phaseNumber,
        tasks_deleted: deletedTasks.changes,
        phase_count: newCount,
        folder_removed: folderRemoved,
        next_step_hint: `Phase ${phaseNumber} and ${deletedTasks.changes} task(s) permanently deleted.`,
      });
    }

    // POST /api/projects/:id/sync — reconcile filesystem from DB
    const syncMatch = p.match(/^\/api\/projects\/([^/]+)\/sync$/);
    if (syncMatch && method === 'POST') {
      const projectId = syncMatch[1];
      const project = stmts.getProject.get(projectId);
      if (!project) return Response.json({ error: 'project not found' }, { status: 404 });
      const tasks = stmts.listTasksByCortexProject.all(projectId);
      let synced = 0;
      for (const task of tasks) {
        try {
          syncTaskFileLifecycle({ stmts, taskId: task.id, phase: task.phase_number || 1 });
          synced++;
        } catch { /* best effort */ }
      }
      return Response.json({ project_id: projectId, tasks_synced: synced, total: tasks.length });
    }

    const projectMatch = p.match(/^\/api\/projects\/([^/]+)(\/summary)?$/);
    if (projectMatch && method === 'GET') {
      const projectId = projectMatch[1];
      const project = stmts.getProject.get(projectId);
      if (!project) return Response.json({ error: 'project not found' }, { status: 404 });
      const tasks = stmts.listTasksByCortexProject.all(projectId);
      const cost = stmts.projectCostSummary.get(projectId) || {};
      if (projectMatch[2] === '/summary') {
        const counts = stmts.projectTaskCounts.get(projectId) || {};
        return Response.json({
          project: project.name,
          summary: `${counts.completed_count || 0}/${counts.task_count || 0} tasks done. ${counts.in_progress_count || 0} in progress. ${counts.review_count || 0} in review. $${(cost.total_cost_usd || 0).toFixed(2)} spent.`,
          blockers: tasks.filter((task) => task.status === 'review').map((task) => ({
            task_id: task.id,
            title: task.title,
            status: task.status,
            blocked_since: isoFromUnix(task.updated_at || task.created_at),
          })),
          next_step_hint: `${counts.review_count || 0} tasks in review. Consider investigating blockers.`,
        });
      }
      return Response.json({
        id: project.id,
        name: project.name,
        description: project.description,
        status: project.status,
        slug: project.slug,
        phase_count: project.phase_count ?? 1,
        tasks: tasks.map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          assigned_agent: task.assigned_agent,
          priority: task.priority || 'medium',
          phase_number: task.phase_number || 1,
        })),
        total_cost_usd: cost.total_cost_usd || 0,
        created_at: isoFromUnix(project.created_at),
        next_step_hint: 'Project detail retrieved.',
      });
    }

    // DELETE /api/projects/:id — admin only, cascade delete tasks + workspace folder
    const projectDeleteMatch = p.match(/^\/api\/projects\/([^/]+)$/);
    if (projectDeleteMatch && method === 'DELETE') {
      if (!adminAccess) {
        return Response.json({ error: 'forbidden', message: 'admin token required' }, { status: 403 });
      }
      const projectId = projectDeleteMatch[1];
      const project = stmts.getProject.get(projectId);
      if (!project) return Response.json({ error: 'project not found' }, { status: 404 });

      // Delete task-related records, then tasks, then project — atomic
      const taskIds = db.prepare(`SELECT id FROM cortex_tasks WHERE project_id = ?`).all(projectId).map(r => r.id);
      const deletedTasks = db.transaction(() => {
        for (const tid of taskIds) {
          db.prepare(`DELETE FROM progress_reports WHERE task_id = ?`).run(tid);
          db.prepare(`DELETE FROM task_comments WHERE task_id = ?`).run(tid);
          db.prepare(`DELETE FROM task_rejections WHERE task_id = ?`).run(tid);
          db.prepare(`DELETE FROM audit_log WHERE task_id = ?`).run(tid);
        }
        const result = db.prepare(`DELETE FROM cortex_tasks WHERE project_id = ?`).run(projectId);
        db.prepare(`DELETE FROM cortex_projects WHERE id = ?`).run(projectId);
        return result;
      })();

      // Remove workspace folder if it exists
      let folderRemoved = false;
      if (project.slug) {

        const root = resolveWorkspaceRoot();
        for (const suffix of ['', ' (finished)']) {
          const dir = path.join(root, project.slug + suffix);
          if (existsSync(dir)) {
            try { rmSync(dir, { recursive: true, force: true }); folderRemoved = true; } catch { /* best effort */ }
          }
        }
      }

      return Response.json({
        deleted: true,
        project_id: projectId,
        project_name: project.name,
        tasks_deleted: deletedTasks.changes,
        folder_removed: folderRemoved,
        next_step_hint: 'Project and all associated tasks have been permanently deleted.',
      });
    }

    if (p === '/api/bookkeeper/context' && method === 'POST') {
      let body;
      try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
      if (!body.context_type || !body.content) return Response.json({ error: 'context_type and content are required' }, { status: 400 });
      if (typeof body.content === 'string' && body.content.length > 1048576) return Response.json({ error: 'content exceeds 1MB limit' }, { status: 413 });
      const contextId = genId();
      stmts.createContextSnapshot.run(contextId, agentIdentity, body.session_id || null, body.task_id || null, body.context_type, body.content, JSON.stringify(body.tags || []));
      return Response.json({
        context_id: contextId,
        stored_at: new Date().toISOString(),
        size_chars: body.content.length,
        next_step_hint: 'Context saved. Safe to compact. Use context_retrieve with matching tags to recover.',
      }, { status: 201 });
    }

    if (p === '/api/bookkeeper/context' && method === 'GET') {
      const tags = (url.searchParams.get('tags') || '').split(',').filter(Boolean);
      const since = url.searchParams.get('since');
      const taskId = url.searchParams.get('task_id');
      const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') || 5)), 50);
      let rows = stmts.queryContextSnapshots.all(taskId || null, taskId || null, since ? Math.floor(new Date(since).getTime() / 1000) : null, since ? Math.floor(new Date(since).getTime() / 1000) : null, limit);
      // Agent scoping: non-admin only sees own contexts
      if (!adminAccess) rows = rows.filter((row) => row.agent_id === agentIdentity);
      if (tags.length) rows = rows.filter((row) => tags.every((tag) => jsonParse(row.tags, []).includes(tag)));
      return Response.json({
        contexts: rows.map((row) => ({
          context_id: row.id,
          context_type: row.context_type,
          tags: jsonParse(row.tags, []),
          content: row.content,
          stored_at: isoFromUnix(row.created_at),
          size_chars: row.content.length,
        })),
        total: rows.length,
        next_step_hint: 'Context retrieved. Review and continue.',
      });
    }

    if (p === '/api/bookkeeper/contexts' && method === 'GET') {
      const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') || 20)), 100);
      const type = url.searchParams.get('type');
      let rows = type ? stmts.listContextSnapshotsByType.all(type, limit) : stmts.listContextSnapshots.all(limit);
      // Agent scoping: non-admin only sees own contexts
      if (!adminAccess) rows = rows.filter((row) => row.agent_id === agentIdentity);
      return Response.json({
        contexts: rows.map((row) => ({
          context_id: row.id,
          context_type: row.context_type,
          tags: jsonParse(row.tags, []),
          preview: row.content.slice(0, 120),
          stored_at: isoFromUnix(row.created_at),
          size_chars: row.content.length,
        })),
        total: rows.length,
        next_step_hint: 'Use context_retrieve with tags or context_id for full content.',
      });
    }

    if (p === '/api/gateway/telemetry' && method === 'POST') {
      let body;
      try {
        body = await safeJson(req);
      } catch (e) {
        return Response.json({ ok: false, error: e.status === 413 ? 'payload_too_large' : 'invalid_json' }, { status: e.status || 400 });
      }
      const requestId = typeof body.request_id === 'string' && body.request_id ? body.request_id : genId();
      const methodText = typeof body.method === 'string' && body.method ? body.method : 'OBSERVE';
      const pathText = typeof body.endpoint === 'string' && body.endpoint ? body.endpoint : 'unknown';
      const provider = typeof body.provider === 'string' ? body.provider : 'unknown';
      const model = typeof body.model === 'string' ? body.model : null;
      // In hardened mode, agent_id comes from token, not body
      const agentId = agentIdentity || 'unknown';
      const projectId = typeof body.project_id === 'string' ? body.project_id : null;
      const tokensIn = Number.isFinite(Number(body.tokens_in)) ? Number(body.tokens_in) : 0;
      const tokensOut = Number.isFinite(Number(body.tokens_out)) ? Number(body.tokens_out) : 0;
      const costUsd = Number.isFinite(Number(body.cost_usd)) ? Number(body.cost_usd) : 0;
      const latencyMs = Number.isFinite(Number(body.latency_ms)) ? Number(body.latency_ms) : 0;
      const statusCode = Number.isFinite(Number(body.status_code)) ? Number(body.status_code) : 200;
      const errorText = typeof body.error === 'string' && body.error ? body.error.slice(0, 2000) : null;
      stmts.insertLog.run(requestId, methodText, pathText, provider, model, agentId, projectId, tokensIn, tokensOut, costUsd, latencyMs, statusCode, errorText);
      return Response.json({ ok: true, request_id: requestId });
    }

    // ==================== Subagent Tracking ====================

    if (p === '/api/subagents/event' && method === 'POST') {
      let body;
      try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
      const eventId = genId();
      const parentAgent = agentIdentity || body.parent_agent || 'unknown';
      const subagentId = body.subagent_id || `${parentAgent}:${body.subagent_type || 'general'}-${Date.now()}`;
      const subagentType = body.subagent_type || 'general-purpose';
      const description = body.description || '';
      const taskId = body.task_id || null;
      stmts.createSubagentEvent.run(eventId, parentAgent, subagentId, subagentType, description, taskId);
      return Response.json({ ok: true, event_id: eventId, subagent_id: subagentId }, { status: 201 });
    }

    if (p === '/api/subagents/complete' && method === 'POST') {
      let body;
      try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
      if (!body.event_id) return Response.json({ error: 'event_id required' }, { status: 400 });
      const evt = stmts.getSubagentEvent.get(body.event_id);
      if (!evt) return Response.json({ error: 'event not found' }, { status: 404 });
      const status = body.status || 'completed';
      // Auto-calculate duration from started_at if not provided
      const duration = body.duration_ms || (evt.started_at ? (Math.floor(Date.now() / 1000) - evt.started_at) * 1000 : 0);
      stmts.completeSubagentEvent.run(status, duration, body.tool_calls || 0, body.result_summary || null, body.event_id);
      return Response.json({ ok: true, event_id: body.event_id, status, duration_ms: duration });
    }

    if (p === '/api/subagents' && method === 'GET') {
      const parent = url.searchParams.get('parent') || (adminAccess ? null : agentIdentity);
      const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') || 50)), 200);
      const events = parent
        ? stmts.listSubagentsByParent.all(parent, limit)
        : stmts.listSubagentsRecent.all(limit);
      // Enrich with task title
      const enriched = events.map(e => {
        const task = e.task_id ? stmts.getCortexTask.get(e.task_id) : null;
        return { ...e, task_title: task?.title || null };
      });
      return Response.json({ subagents: enriched, total: enriched.length });
    }

    const subagentTaskMatch = p.match(/^\/api\/subagents\/task\/([^/]+)$/);
    if (subagentTaskMatch && method === 'GET') {
      const events = stmts.listSubagentsByTask.all(subagentTaskMatch[1]);
      return Response.json({ subagents: events, total: events.length });
    }

    if (p === '/api/model/calls' && method === 'GET') {
      const model = url.searchParams.get('model');
      const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') || 100)), 1000);

      // Non-admin callers only see their own calls.
      const agentId = adminAccess ? (url.searchParams.get('agent_id') || agentIdentity) : agentIdentity;
      const logs = queryLogs({ agentId, model, limit });
      const calls = logs.map(l => ({
        source_agent: l.agent_id,
        provider: l.provider,
        model: l.model,
        tokens_in: l.tokens_in,
        tokens_out: l.tokens_out,
        cost_usd: l.cost_usd,
        latency_ms: l.latency_ms,
        status_code: l.status_code,
        timestamp: l.timestamp,
      }));
      return Response.json({ ok: true, calls });
    }

    // ==================== Cortex Hard Gates — Task State Machine ====================

    if (p === '/heartbeat' && method === 'POST') {
      let body;
      try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
      // In hardened mode, override agent_id from token
      if (agentIdentity) body.agent_id = agentIdentity;
      const r = cortexTasks.heartbeat({ task_id: body.current_task, status: body.status }, { agentIdentity });
      return Response.json(r.body, { status: r.status });
    }

    if (p === '/tasks/next' && method === 'GET') {
      const platform = agentIdentity || url.searchParams.get('platform');
      const r = cortexTasks.getNext(platform, { agentIdentity });
      return Response.json(r.body, { status: r.status });
    }

    if (p === '/api/tasks/next' && method === 'GET') {
      const platform = url.searchParams.get('platform') || agentIdentity;
      const r = cortexTasks.getNext(platform, { agentIdentity });
      return Response.json(r.body, { status: r.status });
    }

    if (p === '/agents/stale' && method === 'GET') {
      // Admin only in hardened mode
      if (!adminAccess) {
        return Response.json({ error: 'admin access required' }, { status: 403 });
      }
      const seconds = url.searchParams.get('seconds');
      const r = cortexTasks.staleAgents(seconds);
      return Response.json(r.body, { status: r.status });
    }

    // ── Delete request management (must be before :id routes) ──
    if (p === '/api/tasks/delete-requests' && method === 'GET') {
      if (!adminAccess) return Response.json({ error: 'admin required' }, { status: 403 });
      const requests = stmts.listDeleteRequests.all();
      return Response.json({ requests, total: requests.length });
    }
    if (p === '/api/tasks/delete-requests/approve-all' && method === 'POST') {
      if (!adminAccess) return Response.json({ error: 'admin required' }, { status: 403 });
      const pending = stmts.listDeleteRequests.all();
      let deleted = 0;
      for (const task of pending) {
        try {
          db.transaction(() => {
            db.prepare(`DELETE FROM progress_reports WHERE task_id = ?`).run(task.id);
            db.prepare(`DELETE FROM task_comments WHERE task_id = ?`).run(task.id);
            db.prepare(`DELETE FROM task_rejections WHERE task_id = ?`).run(task.id);
            db.prepare(`DELETE FROM audit_log WHERE task_id = ?`).run(task.id);
            db.prepare(`DELETE FROM cortex_tasks WHERE id = ?`).run(task.id);
          })();
          if (task.project_id) {
            try {
              const project = stmts.getProject.get(task.project_id);
              if (project?.slug) {
                const wsRoot = resolveWorkspaceRoot();
                for (const ps of ['', ' (finished)']) {
                  const pd = path.join(wsRoot, project.slug + ps);
                  if (!existsSync(pd)) continue;
                  for (const phs of ['', ' (finished)']) {
                    const phd = path.join(pd, 'tasks', `phase-${task.phase_number || 1}${phs}`);
                    const td = findTaskFolderByUuid(phd, task.id);
                    if (td) { try { rmSync(td, { recursive: true, force: true }); } catch {} break; }
                  }
                }
              }
            } catch {}
          }
          deleted++;
        } catch {}
      }
      return Response.json({ approved: deleted, total: pending.length });
    }
    if (p === '/api/tasks/delete-requests/deny-all' && method === 'POST') {
      if (!adminAccess) return Response.json({ error: 'admin required' }, { status: 403 });
      const pending = stmts.listDeleteRequests.all();
      for (const task of pending) {
        stmts.clearDeleteRequest.run(task.id);
        stmts.insertAudit.run(task.id, agentIdentity || 'admin', 'delete_denied', '{}');
      }
      return Response.json({ denied: pending.length });
    }

    // Cortex task routes: /tasks/:id, /tasks/:id/claim, /tasks/:id/progress, etc.
    const apiTaskMatch = p.match(/^\/api\/tasks\/([^/]+)(\/.*)?$/);
    if (apiTaskMatch) {
      const taskId = apiTaskMatch[1];
      const sub = apiTaskMatch[2] || '';

      if (sub === '' && method === 'GET') {
        const r = cortexTasks.getTask(taskId);
        if (!adminAccess && r.status === 200 && r.body) {
          const t = r.body;
          const id = (agentIdentity || '').toLowerCase();
          const canSee = (t.assigned_agent || '').toLowerCase() === id
            || (t.created_by || '').toLowerCase() === id
            || (t.reviewer_agent || t.reviewer || '').toLowerCase() === id;
          if (!canSee) return Response.json({ error: 'forbidden', message: 'not your task' }, { status: 403 });
        }
        return Response.json(r.body, { status: r.status });
      }

      if (sub === '' && method === 'PATCH') {
        let body;
        try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
        const r = cortexTasks.update(taskId, body, { agentIdentity, isAdmin: adminAccess });
        return Response.json(r.body, { status: r.status });
      }

      // DELETE /api/tasks/:id — admin only, remove task + workspace folder
      if (sub === '' && method === 'DELETE') {
        if (!adminAccess) {
          return Response.json({ error: 'forbidden', message: 'admin token required' }, { status: 403 });
        }
        const task = stmts.getCortexTask.get(taskId);
        if (!task) return Response.json({ error: 'task not found' }, { status: 404 });

        // Remove task folder from workspace if it has a project
        let folderRemoved = false;
        if (task.project_id) {
          const project = stmts.getProject.get(task.project_id);
          if (project && project.slug) {
            const wsRoot = resolveWorkspaceRoot();
            const projectDir = existsSync(path.join(wsRoot, project.slug))
              ? path.join(wsRoot, project.slug)
              : existsSync(path.join(wsRoot, `${project.slug} (finished)`))
                ? path.join(wsRoot, `${project.slug} (finished)`)
                : null;
            if (projectDir) {
              const phaseNumber = task.phase_number || 1;
              const tasksDir = path.join(projectDir, 'tasks');
              for (const suffix of ['', ' (finished)']) {
                const phaseDir = path.join(tasksDir, `phase-${phaseNumber}${suffix}`);
                const taskDir = findTaskFolderByUuid(phaseDir, taskId);
                if (taskDir) {
                  try { rmSync(taskDir, { recursive: true, force: true }); folderRemoved = true; } catch { /* best effort */ }
                  break;
                }
              }
            }
          }
        }

        // Delete from DB — atomic
        db.transaction(() => {
          db.prepare(`DELETE FROM progress_reports WHERE task_id = ?`).run(taskId);
          db.prepare(`DELETE FROM task_comments WHERE task_id = ?`).run(taskId);
          db.prepare(`DELETE FROM task_rejections WHERE task_id = ?`).run(taskId);
          db.prepare(`DELETE FROM audit_log WHERE task_id = ?`).run(taskId);
          db.prepare(`DELETE FROM cortex_tasks WHERE id = ?`).run(taskId);
        })();

        return Response.json({
          deleted: true,
          task_id: taskId,
          title: task.title,
          folder_removed: folderRemoved,
          next_step_hint: 'Task and all associated data have been permanently deleted.',
        });
      }

      if (sub === '/claim' && method === 'POST') {
        let claimAgent = agentIdentity;
        let claimPlatform = agentIdentity;
        if (adminAccess) {
          try {
            const body = await safeJson(req);
            if (body.agent) claimAgent = body.agent;
            if (body.platform) claimPlatform = body.platform;
          } catch { /* no body is fine */ }
        }
        const r = cortexTasks.claim(taskId, { agentIdentity: claimAgent, platform: claimPlatform || claimAgent });
        return Response.json(r.body, { status: r.status });
      }

      if (sub === '/progress' && method === 'POST') {
        let body;
        try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
        const r = cortexTasks.progress(taskId, body, { agentIdentity });
        return Response.json(r.body, { status: r.status });
      }

      if (sub === '/submit' && method === 'POST') {
        let body;
        try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
        const r = cortexTasks.submit(taskId, body, { agentIdentity });
        return Response.json(r.body, { status: r.status });
      }

      if (sub === '/request-review' && method === 'POST') {
        let body;
        try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
        const r = cortexTasks.requestReview(taskId, body, { agentIdentity });
        return Response.json(r.body, { status: r.status });
      }

      if (sub === '/approve' && method === 'POST') {
        let body;
        try { body = await safeJson(req); } catch { body = {}; }
        const r = cortexTasks.approve(taskId, body, { agentIdentity, isAdmin: adminAccess });
        return Response.json(r.body, { status: r.status });
      }

      if (sub === '/reject' && method === 'POST') {
        let body;
        try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
        const r = cortexTasks.reject(taskId, body, { agentIdentity, isAdmin: adminAccess });
        return Response.json(r.body, { status: r.status });
      }

      if (sub === '/cancel' && method === 'POST') {
        let body;
        try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
        const r = cortexTasks.cancel(taskId, body, { agentIdentity, isAdmin: adminAccess });
        return Response.json(r.body, { status: r.status });
      }

      if (sub === '/release' && method === 'POST') {
        let body;
        try { body = await safeJson(req); } catch { body = {}; }
        const r = cortexTasks.release(taskId, body, { agentIdentity, isAdmin: adminAccess });
        return Response.json(r.body, { status: r.status });
      }

      if (sub === '/reassign' && method === 'POST') {
        let body;
        try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
        const r = cortexTasks.reassign(taskId, body, { agentIdentity, isAdmin: adminAccess });
        return Response.json(r.body, { status: r.status });
      }

      if (sub === '/comments' && method === 'POST') {
        let body;
        try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
        const r = cortexTasks.comment(taskId, body, { agentIdentity });
        return Response.json(r.body, { status: r.status });
      }

      if (sub === '/reopen' && method === 'POST') {
        let body;
        try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
        const r = cortexTasks.reopen(taskId, body, { agentIdentity, isAdmin: adminAccess });
        return Response.json(r.body, { status: r.status });
      }

      // ── Delete request flow ──
      if (sub === '/request-delete' && method === 'POST') {
        const task = stmts.getCortexTask.get(taskId);
        if (!task) return Response.json({ error: 'task not found' }, { status: 404 });
        if (!adminAccess) {
          const id = (agentIdentity || '').toLowerCase();
          const isOwner = (task.assigned_agent || '').toLowerCase() === id || (task.created_by || '').toLowerCase() === id;
          if (!isOwner) return Response.json({ error: 'can only request deletion of your own tasks' }, { status: 403 });
        }
        stmts.requestDeleteTask.run(agentIdentity || 'admin', taskId);
        stmts.insertAudit.run(taskId, agentIdentity || 'admin', 'delete_requested', JSON.stringify({ reason: 'Deletion requested' }));
        try {
          const eid = genId();
          stmts.bridgeSend.run(eid, 'cortex-system', 'admin', 'notification',
            JSON.stringify({ event: 'delete_requested', task_id: taskId, title: task.title, requested_by: agentIdentity }),
            taskId, '[]', 'Delete request: ' + task.title, 'urgent', taskId, null, 'task_event', '{}', 0, null);
        } catch { /* best effort */ }
        return Response.json({ task_id: taskId, delete_requested: true, requested_by: agentIdentity, next_step_hint: 'Delete request sent to admin for approval.' });
      }

      if (sub === '/approve-delete' && method === 'POST') {
        if (!adminAccess) return Response.json({ error: 'admin required' }, { status: 403 });
        const task = stmts.getCortexTask.get(taskId);
        if (!task) return Response.json({ error: 'task not found' }, { status: 404 });
        if (!task.delete_requested_at) return Response.json({ error: 'no delete request pending' }, { status: 409 });
        db.transaction(() => {
          db.prepare(`DELETE FROM progress_reports WHERE task_id = ?`).run(taskId);
          db.prepare(`DELETE FROM task_comments WHERE task_id = ?`).run(taskId);
          db.prepare(`DELETE FROM task_rejections WHERE task_id = ?`).run(taskId);
          db.prepare(`DELETE FROM audit_log WHERE task_id = ?`).run(taskId);
          db.prepare(`DELETE FROM cortex_tasks WHERE id = ?`).run(taskId);
        })();
        let folderRemoved = false;
        if (task.project_id) {
          try {
            const project = stmts.getProject.get(task.project_id);
            if (project?.slug) {
              const wsRoot = resolveWorkspaceRoot();
              for (const ps of ['', ' (finished)']) {
                const pd = path.join(wsRoot, project.slug + ps);
                if (!existsSync(pd)) continue;
                for (const phs of ['', ' (finished)']) {
                  const phd = path.join(pd, 'tasks', `phase-${task.phase_number || 1}${phs}`);
                  const td = findTaskFolderByUuid(phd, taskId);
                  if (td) { try { rmSync(td, { recursive: true, force: true }); folderRemoved = true; } catch {} break; }
                }
                if (folderRemoved) break;
              }
            }
          } catch {}
        }
        return Response.json({ deleted: true, task_id: taskId, folder_removed: folderRemoved });
      }

      if (sub === '/deny-delete' && method === 'POST') {
        if (!adminAccess) return Response.json({ error: 'admin required' }, { status: 403 });
        stmts.clearDeleteRequest.run(taskId);
        stmts.insertAudit.run(taskId, agentIdentity || 'admin', 'delete_denied', '{}');
        return Response.json({ task_id: taskId, delete_denied: true });
      }

      if (sub === '/audit' && method === 'GET') {
        const audit = stmts.getAuditByTask.all(taskId);
        return Response.json({ task_id: taskId, audit, total: audit.length });
      }
    }

    // PATCH /api/projects/:id — update project metadata
    const projectPatchMatch = p.match(/^\/api\/projects\/([^/]+)$/);
    if (projectPatchMatch && method === 'PATCH') {
      let body;
      try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
      const projectId = projectPatchMatch[1];
      const project = stmts.getProject.get(projectId);
      if (!project) return Response.json({ error: 'project not found' }, { status: 404 });
      if (body.name) db.prepare(`UPDATE cortex_projects SET name = ?, updated_at = unixepoch() WHERE id = ?`).run(body.name, projectId);
      if (body.description) db.prepare(`UPDATE cortex_projects SET description = ?, updated_at = unixepoch() WHERE id = ?`).run(body.description, projectId);
      if (body.status) db.prepare(`UPDATE cortex_projects SET status = ?, updated_at = unixepoch() WHERE id = ?`).run(body.status, projectId);
      if (body.default_reviewer !== undefined) db.prepare(`UPDATE cortex_projects SET default_reviewer = ?, updated_at = unixepoch() WHERE id = ?`).run(body.default_reviewer || null, projectId);
      const updated = stmts.getProject.get(projectId);
      return Response.json({ id: projectId, name: updated.name, status: updated.status, updated: true });
    }

    // PATCH /api/agents/:id — update agent metadata (self or admin)
    const agentPatchMatch = p.match(/^\/api\/agents\/([^/]+)$/);
    if (agentPatchMatch && method === 'PATCH') {
      const targetAgent = agentPatchMatch[1];
      if (!adminAccess && agentIdentity !== targetAgent) return Response.json({ error: 'can only update your own agent card' }, { status: 403 });
      let body;
      try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
      const aid = agentPatchMatch[1];
      const agent = stmts.getAgent.get(aid);
      if (!agent) return Response.json({ error: 'agent not found' }, { status: 404 });
      if (body.model) db.prepare(`UPDATE agents SET model = ? WHERE id = ?`).run(body.model, aid);
      if (body.provider) db.prepare(`UPDATE agents SET provider = ? WHERE id = ?`).run(body.provider, aid);
      if (body.status) db.prepare(`UPDATE agents SET status = ? WHERE id = ?`).run(body.status, aid);
      return Response.json({ agent_id: aid, updated: true });
    }

    const ctxTaskMatch = p.match(/^\/tasks\/([^/]+)(\/.*)?$/);
    if (ctxTaskMatch) {
      const taskId = ctxTaskMatch[1];
      const sub = ctxTaskMatch[2] || '';

      if (sub === '' && method === 'GET') {
        const r = cortexTasks.getTask(taskId);
        // Scope: agent can only view own tasks
        if (!adminAccess && r.status === 200) {
          const task = r.body;
          if (task.assigned_agent && task.assigned_agent !== agentIdentity && task.assigned_platform !== agentIdentity) {
            return Response.json({ error: 'forbidden: not your task' }, { status: 403 });
          }
        }
        return Response.json(r.body, { status: r.status });
      }

      if (sub === '/claim' && method === 'POST') {
        let body;
        try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
        // Admin can claim on behalf of any agent; non-admin forced to own identity
        const r = cortexTasks.claim(taskId, { agentIdentity, platform: agentIdentity });
        return Response.json(r.body, { status: r.status });
      }

      if (sub === '/progress' && method === 'POST') {
        let body;
        try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
        const r = cortexTasks.progress(taskId, body, { agentIdentity });
        return Response.json(r.body, { status: r.status });
      }

      if (sub === '/progress' && method === 'GET') {
        const r = cortexTasks.getProgress(taskId);
        return Response.json(r.body, { status: r.status });
      }

      if (sub === '/submit' && method === 'POST') {
        let body;
        try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
        const r = cortexTasks.submit(taskId, { summary: body.result_summary || body.summary, files_changed: body.files_changed }, { agentIdentity });
        return Response.json(r.body, { status: r.status });
      }

      if (sub === '/verify' && method === 'POST') {
        let body;
        try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
        const r = cortexTasks.requestReview(taskId, { reviewer: body.reviewer_agent }, { agentIdentity });
        return Response.json(r.body, { status: r.status });
      }

      if (sub === '/verdict' && method === 'POST') {
        let body;
        try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
        const r = body.decision === 'approved'
          ? cortexTasks.approve(taskId, { comment: body.feedback }, { agentIdentity, isAdmin: adminAccess })
          : cortexTasks.reject(taskId, { reason: body.feedback || 'Rejected', guidance: null }, { agentIdentity, isAdmin: adminAccess });
        return Response.json(r.body, { status: r.status });
      }

      if (sub === '/release' && method === 'POST') {
        let body;
        try { body = await safeJson(req); } catch { body = {}; }
        const r = cortexTasks.release(taskId, body, { agentIdentity, isAdmin: adminAccess });
        return Response.json(r.body, { status: r.status });
      }

      if (sub === '/reassign' && method === 'PATCH') {
        let body;
        try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
        const r = cortexTasks.reassign(taskId, { new_agent: body.agent_id }, { agentIdentity, isAdmin: adminAccess });
        return Response.json(r.body, { status: r.status });
      }

      if (sub === '/fail' && method === 'POST') {
        // Admin or watchdog only
        if (!adminAccess) {
          return Response.json({ error: 'admin access required to fail tasks' }, { status: 403 });
        }
        let body;
        try { body = await safeJson(req); } catch { body = {}; }
        const r = cortexTasks.fail(taskId, body);
        return Response.json(r.body, { status: r.status });
      }

      if (sub === '/audit' && method === 'GET') {
        // Admin only in hardened mode
        if (!adminAccess) {
          return Response.json({ error: 'admin access required' }, { status: 403 });
        }
        const r = cortexTasks.getAudit(taskId);
        return Response.json(r.body, { status: r.status });
      }
    }

    // POST /tasks — create cortex task (agents and admins)
    if (p === '/tasks' && method === 'POST') {
      let body;
      try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
      const r = cortexTasks.create(body, { agentIdentity, isAdmin: adminAccess });
      return Response.json(r.body, { status: r.status });
    }

    // GET /tasks — list cortex tasks (scoped)
    if (p === '/tasks' && method === 'GET') {
      const r = cortexTasks.list({
        status: url.searchParams.get('status'),
        limit: url.searchParams.get('limit'),
      });
      // Scope: agent only sees own tasks
      if (!adminAccess && r.body.tasks) {
        r.body.tasks = scopeTasks(r.body.tasks, agentIdentity);
      }
      return Response.json(r.body, { status: r.status });
    }

    if (p === '/api/tasks' && method === 'POST') {
      let body;
      try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
      const r = cortexTasks.create(body, { agentIdentity, isAdmin: adminAccess });
      return Response.json(r.body, { status: r.status });
    }

    // (delete-request routes moved above apiTaskMatch)

    if (p === '/api/tasks' && method === 'GET') {
      const r = cortexTasks.list({
        status: url.searchParams.get('status'),
        agent: url.searchParams.get('agent'),
        project_id: url.searchParams.get('project_id'),
        source: url.searchParams.get('source'),
        limit: url.searchParams.get('limit'),
      }, { agentIdentity, isAdmin: adminAccess });
      return Response.json(r.body, { status: r.status });
    }

    // ==================== Bot Routes ====================

    if (p === '/bots/register' && method === 'POST') {
      let body;
      try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
      const { id, name, version, endpoint, capabilities, meta } = body;
      if (!id || !name) {
        return Response.json({ error: 'id and name are required' }, { status: 400 });
      }
      stmts.registerBot.run(id, name, version || '0.0.0', endpoint || '', JSON.stringify(capabilities || []), Date.now(), JSON.stringify(meta || {}));
      return Response.json({ ok: true, id });
    }

    if (p === '/bots' && method === 'GET') {
      const bots = stmts.listBots.all().map(b => ({ ...b, capabilities: jsonParse(b.capabilities, []), meta: jsonParse(b.meta, {}) }));
      return Response.json({ bots });
    }

    const botMatch = p.match(/^\/bots\/(?!register\b)([^/]+)(\/.*)?$/);
    if (botMatch) {
      const botId = botMatch[1];
      const sub = botMatch[2] || '';

      if (sub === '/heartbeat' && method === 'POST') {
        stmts.heartbeat.run(Date.now(), botId);
        return Response.json({ ok: true });
      }

      if (sub === '/offline' && method === 'POST') {
        const result = stmts.markOffline.run(botId);
        if (result.changes === 0) {
          return Response.json({ ok: false, error: 'bot not found or already offline' }, { status: 404 });
        }
        return Response.json({ ok: true });
      }

      if (sub === '/unregister' && method === 'POST') {
        stmts.unregisterBot.run(botId);
        return Response.json({ ok: true });
      }

      if (sub === '' && method === 'GET') {
        const bot = stmts.getBot.get(botId);
        if (!bot) return Response.json({ error: 'not found' }, { status: 404 });
        return Response.json({ ...bot, capabilities: jsonParse(bot.capabilities, []), meta: jsonParse(bot.meta, {}) });
      }

      // --- Tasks ---
      if (sub === '/tasks' && method === 'GET') {
        return Response.json({ tasks: tasks.getPending(botId) });
      }

      if (sub === '/tasks' && method === 'POST') {
        let body;
        try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
        const { projectId, type, payload } = body;
        if (!type) return Response.json({ error: 'type is required' }, { status: 400 });
        const taskId = tasks.create(botId, projectId, type, payload);
        return Response.json({ ok: true, taskId });
      }

      const taskResultMatch = sub.match(/^\/tasks\/([^/]+)\/result$/);
      if (taskResultMatch && method === 'POST') {
        let body;
        try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
        const { status, result } = body;
        tasks.complete(taskResultMatch[1], status, result);
        return Response.json({ ok: true });
      }

      const taskStartMatch = sub.match(/^\/tasks\/([^/]+)\/start$/);
      if (taskStartMatch && method === 'POST') {
        tasks.start(taskStartMatch[1]);
        return Response.json({ ok: true });
      }

      // --- Usage ---
      if (sub === '/usage' && method === 'POST') {
        let body;
        try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
        const { projectId, type, units, unitLabel, costUsd, meta } = body;
        if (!type || units == null) return Response.json({ error: 'type and units required' }, { status: 400 });
        stmts.recordUsage.run(botId, projectId || null, type, units, unitLabel || 'tokens', costUsd || 0, Date.now(), JSON.stringify(meta || {}));
        return Response.json({ ok: true });
      }

      if (sub === '/usage' && method === 'GET') {
        const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') || 100)), 1000);
        return Response.json({ usage: stats.usageByBot(botId, limit) });
      }
    }

    // ==================== API Routes ====================

    // --- /api/model ---
    if (p === '/api/model/list' && method === 'GET') {
      try {
        const result = await models.list();
        return Response.json(result);
      } catch (e) {
        return Response.json({ error: 'ollama unavailable' }, { status: 502 });
      }
    }

    if (p === '/api/model/chat' && method === 'POST') {
      try {
        const { model, messages, ...options } = await safeJson(req);
        const result = await models.chat(model, messages, options);
        return Response.json(result);
      } catch (e) {
        return Response.json({ error: 'ollama unavailable' }, { status: 502 });
      }
    }

    const modelDetailMatch = p.match(/^\/api\/model\/(.+)$/);
    if (modelDetailMatch && method === 'GET') {
      try {
        const result = await models.detail(modelDetailMatch[1]);
        return Response.json(result);
      } catch (e) {
        return Response.json({ error: 'ollama unavailable' }, { status: 502 });
      }
    }

    // --- /api/services ---
    if (p === '/api/services/events' && method === 'POST') {
      let body;
      try { body = await safeJson(req); } catch (e) { return Response.json({ error: e.status === 413 ? 'payload_too_large' : 'invalid JSON' }, { status: e.status || 400, headers: addCorsHeaders() }); }
      const { service, event, payload } = body;
      if (!service || !event) return Response.json({ error: 'service and event required' }, { status: 400 });
      services.log(service, event, payload);
      return Response.json({ ok: true });
    }

    if (p === '/api/services/events' && method === 'GET') {
      const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') || 100)), 1000);
      const service = url.searchParams.get('service');
      const events = service ? services.byService(service, limit) : services.list(limit);
      return Response.json({ events });
    }

    // --- /api/stats ---
    if (p === '/costs' && method === 'GET') {
      return Response.json({ summary: stats.costSummary() });
    }

    if (p === '/api/stats/costs' && method === 'GET') {
      return Response.json({ summary: stats.costSummary() });
    }

    // --- Project convenience routes ---
    const projectUsageMatch = p.match(/^\/projects\/([^/]+)\/usage$/);
    if (projectUsageMatch && method === 'GET') {
      const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') || 100)), 1000);
      return Response.json({ usage: stats.usageByProject(projectUsageMatch[1], limit) });
    }

    const projectTasksMatch = p.match(/^\/projects\/([^/]+)\/tasks$/);
    if (projectTasksMatch && method === 'GET') {
      const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') || 50)), 1000);
      return Response.json({ tasks: tasks.byProject(projectTasksMatch[1], limit) });
    }

    return Response.json({ error: 'not found' }, { status: 404, headers: addCorsHeaders() });
   } catch (fetchErr) {
    console.error(`[gateway] UNCAUGHT in fetch handler: ${fetchErr.message}\n${fetchErr.stack?.split('\n').slice(0,5).join('\n')}`);
    return Response.json({ error: 'internal_error', message: fetchErr.message }, { status: 500 });
   }
  },

  websocket: {
    open(ws) {
      addWsClient(ws);
      // Track per-agent WebSocket connections (BUG-25)
      const agentId = ws.data?.identity;
      if (agentId) {
        wsConnectionsPerAgent.set(agentId, (wsConnectionsPerAgent.get(agentId) || 0) + 1);
      }
      ws.send(JSON.stringify({ type: 'connected', service: 'gateway' }));
    },
    close(ws) {
      removeWsClient(ws);
      // Decrement per-agent WebSocket connection count (BUG-25)
      const agentId = ws.data?.identity;
      if (agentId) {
        const count = (wsConnectionsPerAgent.get(agentId) || 1) - 1;
        if (count <= 0) wsConnectionsPerAgent.delete(agentId);
        else wsConnectionsPerAgent.set(agentId, count);
      }
    },
    message(ws, message) {
      // Clients don't send meaningful messages; just acknowledge
    },
  },
});
} catch (err) {
  if (err.code === 'EADDRINUSE' || (err.message && err.message.includes('EADDRINUSE'))) {
    console.error(`[gateway] FATAL: port ${PORT} is already in use`);
  } else {
    console.error(`[gateway] FATAL: failed to start server: ${err.message}`);
  }
  process.exit(1);
}

console.log(`[gateway] listening on http://${HOST}:${PORT}`);
console.log(`[gateway] mode: ${HARDENED ? 'hardened' : 'standard'}`);
console.log(`[gateway] proxy: anthropic, openai, ollama, openrouter`);
console.log(`[gateway] mcp: http://${HOST}:${PORT}/mcp`);
console.log(`[gateway] ws: ws://${HOST}:${PORT}/ws/gateway`);

// --- Log rotation: archive logs older than 30 days on startup ---
try {
  const deleted = db.prepare(`DELETE FROM gateway_logs WHERE timestamp < datetime('now', '-30 days')`).run();
  if (deleted.changes > 0) console.log(`[gateway] log rotation: archived ${deleted.changes} logs older than 30 days`);
} catch { /* best effort */ }

// --- Auto-idle sweep: mark agents idle after 10 minutes of inactivity ---
setInterval(() => {
  try {
    db.prepare(`UPDATE agents SET status = 'idle' WHERE status = 'active' AND last_active < datetime('now', '-10 minutes')`).run();
  } catch { /* best effort */ }
}, 5 * 60 * 1000);
console.log(`[gateway] auto-idle sweep: every 5m, threshold 10m`);

// --- Stale task recovery: release tasks claimed >2h with no recent progress ---
setInterval(() => {
  try {
    const staleThreshold = Math.floor(Date.now() / 1000) - (2 * 60 * 60); // 2 hours
    const staleTasks = db.prepare(`
      SELECT ct.id, ct.title, ct.assigned_agent FROM cortex_tasks ct
      WHERE ct.status IN ('claimed', 'in_progress')
        AND ct.updated_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM progress_reports pr
          WHERE pr.task_id = ct.id AND pr.timestamp > ?
        )
    `).all(staleThreshold, staleThreshold);
    for (const task of staleTasks) {
      db.prepare(`UPDATE cortex_tasks SET status = 'pending', assigned_agent = NULL, assigned_platform = NULL, claimed_at = NULL, updated_at = unixepoch() WHERE id = ?`).run(task.id);
      stmts.insertAudit.run(task.id, 'system', 'stale_task_released', JSON.stringify({ previous_agent: task.assigned_agent, reason: 'no activity for 2 hours' }));
      console.log(`[stale-recovery] released task ${task.id} (${task.title}) — assigned to ${task.assigned_agent}, no activity for 2h`);
    }
  } catch (err) {
    console.error(`[stale-recovery] error: ${err.message}`);
  }
}, 10 * 60 * 1000); // Check every 10 minutes
console.log(`[gateway] stale task recovery: every 10m, threshold 2h`);

// --- Periodic cleanup: stale subagents + expired bridge messages ---
setInterval(() => {
  try {
    const stale = stmts.staleSubagents.run();
    const expired = stmts.expiredBridgeMessages.run();
    if (stale.changes > 0 || expired.changes > 0) {
      console.log(`[cleanup] ${stale.changes} stale subagents, ${expired.changes} expired bridge msgs purged`);
    }
  } catch (e) {
    console.error('[cleanup] periodic cleanup error:', e.message);
  }
}, 10 * 60 * 1000).unref();
console.log(`[gateway] periodic cleanup: every 10m, subagent timeout 1h, bridge msg expiry 24h past expires_at`);

// --- Daily log table pruning ---
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS ?? '30', 10);
setInterval(() => {
  try {
    const tables = ['pruneGatewayLogs', 'pruneOtelEvents', 'pruneAuditLog', 'pruneProgressReports'];
    let totalPruned = 0;
    for (const stmtName of tables) {
      const r = stmts[stmtName].run(LOG_RETENTION_DAYS);
      totalPruned += r.changes;
    }
    if (totalPruned > 0) {
      console.log(`[prune] daily log prune: removed ${totalPruned} rows older than ${LOG_RETENTION_DAYS}d`);
    }
  } catch (e) {
    console.error('[prune] daily log prune error:', e.message);
  }
}, 24 * 60 * 60 * 1000).unref();
console.log(`[gateway] daily log prune: every 24h, retention ${LOG_RETENTION_DAYS}d (LOG_RETENTION_DAYS)`);

// --- Graceful shutdown ---
function shutdown(signal) {
  console.log(`[gateway] ${signal} received, shutting down...`);
  try { db.close(); } catch { /* best effort */ }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
