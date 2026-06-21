import { describe, test, expect } from 'bun:test';
import {
  buildTacticalSnapshot,
  buildRouteTable,
  gatewayProxyRouteSpecs,
  mountGatewayProxyRoutes,
  respondError,
} from '../backend/routes/gateway-proxy.js';

function makeAdapter() {
  const routes = [];
  return {
    routes,
    add: (method, path, handler) => routes.push({ method, path, handler }),
  };
}

function stubGateway(overrides = {}) {
  const calls = [];
  const pass = (name) => async (...args) => {
    calls.push({ name, args });
    const override = overrides[name];
    if (typeof override === 'function') return override(...args);
    return override ?? { ok: true };
  };
  const methods = [
    'health', 'stats', 'listAgents', 'updateAgent', 'registerAgent',
    'heartbeatAgent', 'listTasks', 'getTask', 'getTaskAudit', 'getTaskReadme',
    'createTask', 'updateTask', 'taskAction', 'deleteTask', 'listDeleteRequests',
    'approveAllDeletes', 'denyAllDeletes', 'listProjects', 'getProject',
    'getProjectSummary', 'listProjectPhases', 'createProject', 'updateProject',
    'deleteProject', 'addPhase', 'deletePhase', 'syncProject', 'getBridgeInbox',
    'sendBridge', 'replyBridge', 'ackBridge', 'costs', 'logs', 'listSubagents',
    'subagentsForTask', 'subagentEvent', 'completeSubagent',
  ];
  const api = { _calls: calls };
  for (const m of methods) api[m] = pass(m);
  return api;
}

describe('buildRouteTable', () => {
  test('registers the expected method+path combinations', () => {
    const table = buildRouteTable(stubGateway());
    const specs = table.map(([m, p]) => `${m} ${p}`);
    expect(specs).toContain('GET /api/tasks');
    expect(specs).toContain('POST /api/tasks');
    expect(specs).toContain('GET /api/tasks/:id');
    expect(specs).toContain('POST /api/tasks/:id/claim');
    expect(specs).toContain('POST /api/tasks/:id/submit');
    expect(specs).toContain('POST /api/tasks/:id/approve');
    expect(specs).toContain('GET /api/tasks/delete-requests');
    expect(specs).toContain('GET /api/projects/:id/phases');
    expect(specs).toContain('POST /api/bridge/send');
    expect(specs).toContain('GET /api/bridge/inbox/:agent');
    expect(specs).toContain('GET /api/costs/:agent');
    expect(specs).toContain('GET /api/subagents');
    expect(specs).toContain('GET /api/tactical/snapshot');
  });

  test('delete-requests registered before :id so ordering is safe', () => {
    const table = buildRouteTable(stubGateway());
    const getTaskIdx = table.findIndex(([m, p]) => m === 'GET' && p === '/api/tasks/:id');
    const deleteReqIdx = table.findIndex(([m, p]) => m === 'GET' && p === '/api/tasks/delete-requests');
    expect(deleteReqIdx).toBeLessThan(getTaskIdx);
  });
});

describe('mountGatewayProxyRoutes', () => {
  test('throws without a valid adapter', () => {
    expect(() => mountGatewayProxyRoutes(null, { gateway: stubGateway() })).toThrow();
    expect(() => mountGatewayProxyRoutes({}, { gateway: stubGateway() })).toThrow();
  });

  test('throws without a gateway client', () => {
    expect(() => mountGatewayProxyRoutes(makeAdapter(), {})).toThrow(/gateway client required/);
  });

  test('mounts every entry from the table', () => {
    const adapter = makeAdapter();
    mountGatewayProxyRoutes(adapter, { gateway: stubGateway() });
    expect(adapter.routes.length).toBe(buildRouteTable(stubGateway()).length);
  });

  test('adapter handlers resolve gateway values into an ok() envelope', async () => {
    const adapter = makeAdapter();
    const gateway = stubGateway({ listTasks: async (q) => ({ tasks: [], query: q }) });
    mountGatewayProxyRoutes(adapter, { gateway });
    const entry = adapter.routes.find((r) => r.method === 'GET' && r.path === '/api/tasks');
    const res = { statusCode: 0, headers: {}, body: null,
      setHeader(k, v) { this.headers[k] = v; },
      end(payload) { this.body = payload; } };
    await entry.handler({ req: {}, res, params: {}, query: { status: 'pending' } });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).tasks).toEqual([]);
  });

  test('adapter handlers translate gateway client errors into HTTP codes', async () => {
    const adapter = makeAdapter();
    const gateway = stubGateway({
      getTask: async () => {
        const err = new Error('missing title');
        err.statusCode = 404;
        err.detail = { error: 'not_found', message: 'no such task' };
        throw err;
      },
    });
    mountGatewayProxyRoutes(adapter, { gateway });
    const entry = adapter.routes.find((r) => r.method === 'GET' && r.path === '/api/tasks/:id');
    const res = { statusCode: 0, headers: {}, body: null,
      setHeader(k, v) { this.headers[k] = v; },
      end(payload) { this.body = payload; } };
    await entry.handler({ req: {}, res, params: { id: 'x' }, query: {} });
    expect(res.statusCode).toBe(404);
  });
});

describe('gatewayProxyRouteSpecs', () => {
  test('returns the table in a {method,path,handler} shape', () => {
    const specs = gatewayProxyRouteSpecs(stubGateway());
    expect(Array.isArray(specs)).toBe(true);
    expect(specs[0]).toHaveProperty('method');
    expect(specs[0]).toHaveProperty('path');
    expect(typeof specs[0].handler).toBe('function');
  });
});

describe('respondError', () => {
  test('non-gateway errors yield a 500 envelope', () => {
    const res = { statusCode: 0, headers: {}, body: null,
      setHeader(k, v) { this.headers[k] = v; },
      end(payload) { this.body = payload; } };
    respondError(res, new Error('boom'));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error).toBe('proxy_unknown');
  });

  test('gateway-classified 400 yields badRequest', () => {
    const res = { statusCode: 0, headers: {}, body: null,
      setHeader(k, v) { this.headers[k] = v; },
      end(payload) { this.body = payload; } };
    const err = new Error('bad');
    err.statusCode = 400;
    err.detail = { error: 'bad_request', message: 'bad' };
    respondError(res, err);
    expect(res.statusCode).toBe(400);
  });
});

describe('buildTacticalSnapshot', () => {
  test('merges health+agents+stats+tasks+projects+bridge+logs with phases/tasks enriched', async () => {
    const gateway = {
      health: async () => ({ status: 'ok' }),
      listAgents: async () => ({ agents: [{ id: 'a' }] }),
      stats: async () => ({ count: 42 }),
      listTasks: async () => ({ tasks: [{ id: 't1', project_id: 'p1' }] }),
      listProjects: async () => ({ projects: [{ id: 'p1', name: 'Alpha' }] }),
      getBridgeInbox: async () => ({ messages: [] }),
      logs: async () => ({ logs: [] }),
      listProjectPhases: async () => ({ phases: [{ number: 1 }] }),
    };
    const snap = await buildTacticalSnapshot(gateway);
    expect(snap.health).toEqual({ status: 'ok' });
    expect(snap.projects.projects[0].tasks.length).toBe(1);
    expect(snap.projects.projects[0].phases.length).toBe(1);
  });

  test('surfaces top-level error when every widget fails', async () => {
    const err = Object.assign(new Error('down'), {
      statusCode: 502,
      detail: { error: 'gateway_offline' },
    });
    const gateway = {
      health: async () => { throw err; },
      listAgents: async () => { throw err; },
      stats: async () => { throw err; },
      listTasks: async () => { throw err; },
      listProjects: async () => { throw err; },
      getBridgeInbox: async () => { throw err; },
      logs: async () => { throw err; },
      listProjectPhases: async () => { throw err; },
    };
    const snap = await buildTacticalSnapshot(gateway);
    expect(snap.error).toBe('gateway_offline');
    expect(snap.health.error).toBe('gateway_offline');
  });

  test('tolerates a single failing widget without breaking the others', async () => {
    const gateway = {
      health: async () => ({ status: 'ok' }),
      listAgents: async () => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); },
      stats: async () => ({ count: 1 }),
      listTasks: async () => ({ tasks: [] }),
      listProjects: async () => ({ projects: [] }),
      getBridgeInbox: async () => ({ messages: [] }),
      logs: async () => ({ logs: [] }),
    };
    const snap = await buildTacticalSnapshot(gateway);
    expect(snap.health).toEqual({ status: 'ok' });
    expect(snap.agents.error).toBe('gateway_offline');
    expect(snap.error).toBeUndefined();
  });
});
