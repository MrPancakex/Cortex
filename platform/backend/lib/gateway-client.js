/**
 * Platform → gateway HTTP client.
 *
 * The legacy `routes/gateway-proxy.js` embedded fetch + error-classification
 * in 228 lines of per-route handlers. Phase 10 moves that logic into a
 * single typed client so the dashboard backend is ~90% a router over this
 * file.
 *
 * Architectural rules:
 *   - Rule 1: imports only from @cortex/core, @cortex/sdk, and the gateway
 *     sub-plane barrels — never into gateway internals.
 *   - No DB handles, no auth state mutation. The admin token is loaded
 *     through sdk/auth's canonical path so the platform and gateway cannot
 *     drift on what counts as "admin".
 */
import { loadAdminToken } from '@cortex/sdk/auth';
import { swallow } from '@cortex/sdk/errors';
// GatewayError is the canonical typed error for !ok responses (S4 home:
// sdk/http/client.js). Imported and re-exported so platform consumers have a
// single import for both the client factory and the error type.
import { GatewayError } from '@cortex/sdk/http/client.js';
export { GatewayError };

/**
 * Classify a fetch() rejection into the stable error codes the legacy
 * dashboard consumed. We preserve these strings so the frontend's degraded
 * states keep rendering the same widget banners.
 */
export function classifyFetchError(err) {
  const effective = err?.code || err?.cause?.code || null;
  if (effective === 'ECONNREFUSED') return { code: effective, error: 'gateway_offline', status: 502 };
  if (effective === 'ETIMEDOUT') return { code: effective, error: 'gateway_timeout', status: 504 };
  if (effective === 'ENOTFOUND') return { code: effective, error: 'gateway_unreachable', status: 502 };
  return { code: effective || null, error: 'proxy_unknown', status: 500, message: err?.message || null };
}

function buildHeaders({ token, contentType = 'application/json', extra = {} } = {}) {
  const headers = { ...extra };
  if (contentType) headers['content-type'] = contentType;
  if (token) {
    headers.authorization = `Bearer ${token}`;
    // Preserve the legacy header too so the gateway's compatibility layer
    // (v0.1 routes still look at X-Cortex-Token) keeps working during the
    // crossover.
    headers['x-cortex-token'] = token;
  }
  return headers;
}

/**
 * Create a new gateway client bound to the given base URL + token loader.
 * `tokenLoader` is injectable so tests can drive the client without real
 * filesystem state.
 */
export function createGatewayClient({
  baseUrl,
  tokenLoader = loadAdminToken,
  fetchImpl = fetch,
} = {}) {
  if (!baseUrl) throw new Error('createGatewayClient: baseUrl required');

  async function request(pathname, { method = 'GET', body, token, headers: extraHeaders } = {}) {
    const bearer = token || tokenLoader();
    const url = new URL(pathname, baseUrl);
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: buildHeaders({ token: bearer, extra: extraHeaders }),
        ...(body !== undefined && method !== 'GET' && method !== 'HEAD'
          ? { body: typeof body === 'string' ? body : JSON.stringify(body) }
          : {}),
      });
    } catch (err) {
      swallow('platform.gateway_fetch_failed', err);
      const classified = classifyFetchError(err);
      const out = new Error(classified.message || classified.error);
      out.statusCode = classified.status;
      out.detail = { error: classified.error, code: classified.code };
      out.upstream = 'fetch_error';
      throw out;
    }

    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        swallow('platform.gateway_non_json', err);
        const out = new Error('upstream_non_json');
        out.statusCode = 502;
        out.detail = { error: 'upstream_non_json', status: response.status, snippet: text.slice(0, 500) };
        throw out;
      }
    }

    if (!response.ok) {
      // Use GatewayError (sdk/http/client.js S4 home) so callers can
      // `instanceof GatewayError` across the platform boundary.  The richer
      // statusCode/detail shape is preserved as own properties so existing
      // dashboard error-classification paths keep working.
      const message = parsed?.message || parsed?.error || response.statusText;
      const err = new GatewayError(response.status, message, parsed);
      err.statusCode = response.status;
      err.detail = parsed;
      throw err;
    }
    return parsed;
  }

  return {
    baseUrl,
    request,

    // ---- platform-visible surface ---------------------------------------
    // Ultrareview lens 5 flagged that 40+ flat `/api/*` calls hit the
    // gateway which only mounts `/v1/api/*`. Each method now targets the
    // canonical versioned path — gate policy (006_gate_policies.sql) also
    // whitelists the `/v1/api/*` family, so the call both reaches a real
    // handler and passes the auth check.
    health: () => request('/v1/api/health'),
    stats: () => request('/v1/api/stats'),

    // Agents
    listAgents: () => request('/v1/api/agents'),
    updateAgent: (id, body) => request(`/v1/api/agents/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    registerAgent: (body) => request('/v1/api/agents/register', { method: 'POST', body }),
    heartbeatAgent: (body) => request('/v1/api/heartbeat', { method: 'POST', body }),

    // Tasks
    listTasks: (query = {}) => {
      const qs = new URLSearchParams(query).toString();
      return request(`/v1/api/tasks${qs ? `?${qs}` : ''}`);
    },
    getTask: (id) => request(`/v1/api/tasks/${encodeURIComponent(id)}`),
    getTaskAudit: (id) => request(`/v1/api/tasks/${encodeURIComponent(id)}/audit`),
    getTaskReadme: (id) => request(`/v1/api/tasks/${encodeURIComponent(id)}/readme`),
    createTask: (body) => request('/v1/api/tasks', { method: 'POST', body }),
    updateTask: (id, body) => request(`/v1/api/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    taskAction: (id, action, body) =>
      request(`/v1/api/tasks/${encodeURIComponent(id)}/${action}`, { method: 'POST', body }),
    deleteTask: (id) => request(`/v1/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    listDeleteRequests: () => request('/v1/api/tasks/delete-requests'),
    approveAllDeletes: () => request('/v1/api/tasks/delete-requests/approve-all', { method: 'POST' }),
    denyAllDeletes: () => request('/v1/api/tasks/delete-requests/deny-all', { method: 'POST' }),

    // Projects
    listProjects: () => request('/v1/api/projects'),
    getProject: (id) => request(`/v1/api/projects/${encodeURIComponent(id)}`),
    getProjectSummary: (id) => request(`/v1/api/projects/${encodeURIComponent(id)}/summary`),
    listProjectPhases: (id) => request(`/v1/api/projects/${encodeURIComponent(id)}/phases`),
    createProject: (body) => request('/v1/api/projects', { method: 'POST', body }),
    updateProject: (id, body) => request(`/v1/api/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
    deleteProject: (id) => request(`/v1/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    addPhase: (id, body) => request(`/v1/api/projects/${encodeURIComponent(id)}/phases`, { method: 'POST', body }),
    deletePhase: (id, number) =>
      request(`/v1/api/projects/${encodeURIComponent(id)}/phases/${encodeURIComponent(number)}`, {
        method: 'DELETE',
      }),
    syncProject: (id) => request(`/v1/api/projects/${encodeURIComponent(id)}/sync`, { method: 'POST' }),

    // Bridge — both flat and /v1/ are already mounted by bridge/routes.js,
    // but the client targets /v1/ for parity with every other plane.
    getBridgeInbox: (agent) =>
      request(agent ? `/v1/api/bridge/inbox/${encodeURIComponent(agent)}` : '/v1/api/bridge/inbox'),
    sendBridge: (body) => request('/v1/api/bridge/send', { method: 'POST', body }),
    replyBridge: (id, body) => request(`/v1/api/bridge/reply/${encodeURIComponent(id)}`, { method: 'POST', body }),
    ackBridge: (id, body) =>
      request(id ? `/v1/api/bridge/ack/${encodeURIComponent(id)}` : '/v1/api/bridge/mark-read', {
        method: 'POST',
        body,
      }),

    // Costs + logs
    costs: (agent) => request(`/v1/api/costs/${encodeURIComponent(agent)}`),
    logs: () => request('/v1/api/gateway/logs'),

    // Providers — slice E item 1: cockpit Runtime tab reads on mount.
    listProviders: () => request('/v1/api/providers'),

    // Subagents — slice E item 2: un-stubbed to real HTTP calls.
    // GET /v1/api/subagents             → all recent runs (limit 200)
    // GET /v1/api/subagents?task_id=<X> → runs for a specific task
    // Gateway filters by task_id via query param; the proxy table uses
    // /api/subagents/task/:taskId but the gateway itself accepts ?task_id=.
    listSubagents: (query = {}) => {
      const qs = new URLSearchParams(query).toString();
      return request(`/v1/api/subagents${qs ? `?${qs}` : ''}`);
    },
    subagentsForTask: (taskId) =>
      request(`/v1/api/subagents?task_id=${encodeURIComponent(taskId)}`),
    subagentEvent: notAvailable('subagents.event'),
    completeSubagent: notAvailable('subagents.complete'),
  };
}

function notAvailable(reason) {
  return async () => ({ error: 'not_available', reason, subagents: [] });
}
