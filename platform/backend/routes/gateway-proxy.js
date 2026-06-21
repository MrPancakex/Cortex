/**
 * Thin gateway proxy.
 *
 * The legacy `routes/gateway-proxy.js` was 228 lines of per-route fetch +
 * error classification. Phase 10 collapses it into a table-driven forwarder
 * that delegates every call to the gateway client. The table is the only
 * thing a future phase has to touch when a new upstream endpoint lands.
 *
 * Each entry is shaped `{ method, path, handler }` where `handler(ctx)`
 * receives the router context `{ req, res, params, query, body }` and
 * returns a promise. The router turns the resolved value into `ok(res,
 * value)` and turns any thrown error — including the structured errors
 * the gateway client raises — into the same `{ error, code, ... }`
 * envelope the legacy dashboard consumed.
 */
import { ok, notFound, badRequest } from '@cortex/sdk/http';
import { swallow } from '@cortex/sdk/errors';
import { classifyFetchError } from '../lib/gateway-client.js';

function respondError(res, err) {
  // Gateway client errors carry a `statusCode` + `detail`; use those.
  if (err && err.statusCode) {
    if (err.statusCode === 404) return notFound(res, err.detail?.message || err.message);
    if (err.statusCode === 400) return badRequest(res, err.detail?.message || err.message, err.detail);
    res.statusCode = err.statusCode;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(err.detail || { error: err.message }));
    return undefined;
  }
  swallow('platform.proxy_unknown_error', err);
  const classified = classifyFetchError(err || {});
  res.statusCode = classified.status || 500;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: classified.error, code: classified.code, message: classified.message }));
  return undefined;
}

/**
 * Build a tactical snapshot by fanning out to the gateway for each widget
 * and tolerating individual failures — mirror of the legacy
 * `/api/tactical/snapshot` behavior so the dashboard's home page keeps
 * rendering degraded states instead of blanking out.
 */
export async function buildTacticalSnapshot(gateway) {
  // Per-widget counter name lets operators see which specific widget is
  // degraded on /health — previously a single
  // `platform.snapshot_widget_failed` obscured which widget failed
  // (ultrareview lens 6 I4).
  function safe(widgetName, call) {
    return (async () => {
      try {
        const value = await call();
        return value;
      } catch (err) {
        if (err && err.detail) return err.detail;
        swallow(`platform.snapshot_${widgetName}_failed`, err);
        return classifyFetchError(err || {});
      }
    })();
  }

  const [health, agents, stats, tasks, projects, bridge, logs] = await Promise.all([
    safe('health', () => gateway.health()),
    safe('agents', () => gateway.listAgents()),
    safe('stats', () => gateway.stats()),
    safe('tasks', () => gateway.listTasks()),
    safe('projects', () => gateway.listProjects()),
    safe('bridge', () => gateway.getBridgeInbox()),
    safe('logs', () => gateway.logs()),
  ]);

  let enrichedProjects = projects;
  if (projects?.projects && Array.isArray(projects.projects)) {
    const allTasks = tasks?.tasks || [];
    const phases = await Promise.all(
      projects.projects.map((p) => safe('project_phases', () => gateway.listProjectPhases(p.id))),
    );
    enrichedProjects = {
      ...projects,
      projects: projects.projects.map((p, i) => ({
        ...p,
        tasks: allTasks.filter((t) => t.project_id === p.id),
        phases: phases[i]?.phases || [],
      })),
    };
  }

  const widgets = [health, agents, stats, tasks, projects, bridge, logs];
  const failures = widgets.filter((w) => w && typeof w === 'object' && w.error);
  const topError = failures.length === widgets.length ? failures[0].error : null;

  return {
    ...(topError ? { error: topError } : {}),
    health,
    agents,
    stats,
    tasks,
    projects: enrichedProjects,
    bridge,
    logs,
  };
}

/**
 * Declarative route table. Each handler returns a plain value; the adapter
 * glue in `mountGatewayProxyRoutes` turns it into `ok(res, value)`.
 */
export function buildRouteTable(gateway) {
  return [
    // Health + stats
    ['GET', '/api/gateway/health', () => gateway.health()],
    ['GET', '/api/gateway/stats', () => gateway.stats()],
    ['GET', '/api/stats', () => gateway.stats()],
    ['GET', '/api/gateway/logs', () => gateway.logs()],

    // Agents
    ['GET', '/api/gateway/agents', () => gateway.listAgents()],
    ['PATCH', '/api/agents/:id', (ctx) => gateway.updateAgent(ctx.params.id, ctx.body)],
    ['POST', '/api/agents/register', (ctx) => gateway.registerAgent(ctx.body)],
    ['POST', '/api/agents/heartbeat', (ctx) => gateway.heartbeatAgent(ctx.body)],

    // Projects — collection routes come before :id routes (the router
    // registers them in order so the table can rely on first-match).
    ['GET', '/api/projects', () => gateway.listProjects()],
    ['POST', '/api/projects', (ctx) => gateway.createProject(ctx.body)],
    ['GET', '/api/projects/:id', (ctx) => gateway.getProject(ctx.params.id)],
    ['PATCH', '/api/projects/:id', (ctx) => gateway.updateProject(ctx.params.id, ctx.body)],
    ['DELETE', '/api/projects/:id', (ctx) => gateway.deleteProject(ctx.params.id)],
    ['GET', '/api/projects/:id/summary', (ctx) => gateway.getProjectSummary(ctx.params.id)],
    ['GET', '/api/projects/:id/phases', (ctx) => gateway.listProjectPhases(ctx.params.id)],
    ['POST', '/api/projects/:id/phases', (ctx) => gateway.addPhase(ctx.params.id, ctx.body)],
    ['DELETE', '/api/projects/:id/phases/:number',
      (ctx) => gateway.deletePhase(ctx.params.id, ctx.params.number)],
    ['POST', '/api/projects/:id/sync', (ctx) => gateway.syncProject(ctx.params.id)],

    // Tasks — delete-request collection must be registered before :id so
    // the pattern doesn't swallow them.
    ['GET', '/api/tasks/delete-requests', () => gateway.listDeleteRequests()],
    ['POST', '/api/tasks/delete-requests/approve-all', () => gateway.approveAllDeletes()],
    ['POST', '/api/tasks/delete-requests/deny-all', () => gateway.denyAllDeletes()],
    ['GET', '/api/tasks', (ctx) => gateway.listTasks(ctx.query)],
    ['POST', '/api/tasks', (ctx) => gateway.createTask(ctx.body)],
    ['GET', '/api/tasks/:id', (ctx) => gateway.getTask(ctx.params.id)],
    ['PATCH', '/api/tasks/:id', (ctx) => gateway.updateTask(ctx.params.id, ctx.body)],
    ['DELETE', '/api/tasks/:id', (ctx) => gateway.deleteTask(ctx.params.id)],
    ['GET', '/api/tasks/:id/audit', (ctx) => gateway.getTaskAudit(ctx.params.id)],
    ['GET', '/api/tasks/:id/readme', (ctx) => gateway.getTaskReadme(ctx.params.id)],
    ...[
      'claim', 'resume', 'progress', 'submit', 'request-review', 'approve',
      'reject', 'release', 'reassign', 'reopen', 'cancel', 'fail',
      'request-delete', 'approve-delete', 'deny-delete',
    ].map((action) => [
      'POST',
      `/api/tasks/:id/${action}`,
      (ctx) => gateway.taskAction(ctx.params.id, action, ctx.body),
    ]),

    // Bridge
    ['GET', '/api/bridge/inbox', () => gateway.getBridgeInbox()],
    ['GET', '/api/bridge/inbox/:agent', (ctx) => gateway.getBridgeInbox(ctx.params.agent)],
    ['POST', '/api/bridge/send', (ctx) => gateway.sendBridge(ctx.body)],
    ['POST', '/api/bridge/reply/:id', (ctx) => gateway.replyBridge(ctx.params.id, ctx.body)],
    ['POST', '/api/bridge/ack/:id', (ctx) => gateway.ackBridge(ctx.params.id, ctx.body)],
    ['POST', '/api/bridge/ack', (ctx) => gateway.ackBridge(null, ctx.body)],

    // Costs
    ['GET', '/api/costs/:agent', (ctx) => gateway.costs(ctx.params.agent)],

    // Subagent tracking — ultrareview lens 5 removed the broken
    // forwards. The client methods still return a structured
    // `not_available` so downstream widgets degrade cleanly.
    ['GET', '/api/subagents', (ctx) => gateway.listSubagents(ctx.query)],
    ['GET', '/api/subagents/task/:taskId', (ctx) => gateway.subagentsForTask(ctx.params.taskId)],

    // Providers — cockpit Runtime tab reads this on mount (slice E item 1).
    // Response passes through unmodified; gateway returns the right shape.
    ['GET', '/api/providers', () => gateway.listProviders()],

    // Tactical snapshot
    ['GET', '/api/tactical/snapshot', () => buildTacticalSnapshot(gateway)],
  ];
}

/**
 * Mount the gateway proxy table onto the adapter.
 *
 * @param {{ add: (method: string, path: string, handler: Function) => void }} adapter
 * @param {{ gateway: ReturnType<import('../lib/gateway-client.js').createGatewayClient> }} opts
 */
export function mountGatewayProxyRoutes(adapter, { gateway } = {}) {
  if (!adapter || typeof adapter.add !== 'function') {
    throw new Error('mountGatewayProxyRoutes: adapter must expose add(method, path, handler)');
  }
  if (!gateway || typeof gateway.health !== 'function') {
    throw new Error('mountGatewayProxyRoutes: gateway client required');
  }

  for (const [method, pathPattern, handler] of buildRouteTable(gateway)) {
    adapter.add(method, pathPattern, async (ctx) => {
      try {
        const value = await handler(ctx);
        return ok(ctx.res, value ?? { ok: true });
      } catch (err) {
        return respondError(ctx.res, err);
      }
    });
  }
}

// Kept for use by the dashboard /api/system/reload path that wants to
// short-circuit the proxy for unknown downstream failures with a typed
// envelope. Exported so tests can assert the shape too.
export { respondError };

// The legacy module exported a bare `router`. The rebuild prefers an
// explicit mount helper, but we export a lightweight factory that returns
// the (method, path, handler) table so custom router implementations that
// aren't adapter-shaped can still wire it.
export function gatewayProxyRouteSpecs(gateway) {
  return buildRouteTable(gateway).map(([method, path, handler]) => ({ method, path, handler }));
}

