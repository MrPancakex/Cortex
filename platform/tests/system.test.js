import { describe, test, expect } from 'bun:test';
import { mountSystemRoutes } from '../backend/routes/system.js';

function makeAdapter() {
  const routes = [];
  return {
    routes,
    add: (method, path, handler) => routes.push({ method, path, handler }),
  };
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    headersSent: false,
    setHeader(k, v) { this.headers[k] = v; },
    end(payload) { this.body = payload; this.headersSent = true; },
  };
}

function stubGateway(overrides = {}) {
  return {
    health: async () => overrides.health ?? { status: 'ok' },
    reload: async () => overrides.reload ?? { reloaded: true },
  };
}

describe('mountSystemRoutes', () => {
  test('throws without adapter or gateway', () => {
    expect(() => mountSystemRoutes(null, { gateway: stubGateway() })).toThrow();
    expect(() => mountSystemRoutes(makeAdapter(), {})).toThrow(/gateway client required/);
  });

  test('registers health, features, and reload', () => {
    const adapter = makeAdapter();
    mountSystemRoutes(adapter, { gateway: stubGateway() });
    const paths = adapter.routes.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain('GET /api/system/health');
    expect(paths).toContain('GET /api/system/features');
    expect(paths).toContain('POST /api/system/reload');
  });

  test('health returns platform+gateway payload', async () => {
    const adapter = makeAdapter();
    mountSystemRoutes(adapter, { gateway: stubGateway({ health: { ok: true } }) });
    const route = adapter.routes.find((r) => r.path === '/api/system/health');
    const res = makeRes();
    await route.handler({ req: {}, res });
    const body = JSON.parse(res.body);
    expect(body.platform).toBe('ok');
    expect(body.gateway).toEqual({ ok: true });
  });

  test('health degrades gracefully on gateway failure', async () => {
    const adapter = makeAdapter();
    const gw = {
      health: async () => {
        const err = new Error('offline');
        err.detail = { error: 'gateway_offline' };
        throw err;
      },
    };
    mountSystemRoutes(adapter, { gateway: gw });
    const route = adapter.routes.find((r) => r.path === '/api/system/health');
    const res = makeRes();
    await route.handler({ req: {}, res });
    const body = JSON.parse(res.body);
    expect(body.platform).toBe('ok');
    expect(body.gateway.error).toBe('gateway_offline');
  });

  test('features: admin_console reflects actor kind', async () => {
    const adapter = makeAdapter();
    mountSystemRoutes(adapter, { gateway: stubGateway() });
    const route = adapter.routes.find((r) => r.path === '/api/system/features');

    const resAdmin = makeRes();
    await route.handler({ req: {}, res: resAdmin, actor: { kind: 'admin', id: 'root' } });
    expect(JSON.parse(resAdmin.body).admin_console).toBe(true);

    const resAgent = makeRes();
    await route.handler({ req: {}, res: resAgent, actor: { kind: 'agent', id: 'nova' } });
    expect(JSON.parse(resAgent.body).admin_console).toBe(false);

    const resAnon = makeRes();
    await route.handler({ req: {}, res: resAnon });
    expect(JSON.parse(resAnon.body).admin_console).toBe(false);
  });

  test('reload requires admin', async () => {
    const adapter = makeAdapter();
    mountSystemRoutes(adapter, { gateway: stubGateway() });
    const route = adapter.routes.find((r) => r.path === '/api/system/reload');

    const resAgent = makeRes();
    await route.handler({ req: {}, res: resAgent, actor: { kind: 'agent', id: 'nova' } });
    expect(resAgent.statusCode).toBe(403);

    const resAdmin = makeRes();
    await route.handler({ req: {}, res: resAdmin, actor: { kind: 'admin', id: 'root' } });
    expect(resAdmin.statusCode).toBe(200);
    expect(JSON.parse(resAdmin.body).reloaded).toBe(true);
  });

  test('reload returns 500 when gateway reload throws', async () => {
    const adapter = makeAdapter();
    mountSystemRoutes(adapter, {
      gateway: { health: async () => ({}), reload: async () => { throw new Error('boom'); } },
    });
    const route = adapter.routes.find((r) => r.path === '/api/system/reload');
    const res = makeRes();
    await route.handler({ req: {}, res, actor: { kind: 'admin', id: 'root' } });
    expect(res.statusCode).toBe(500);
  });
});
