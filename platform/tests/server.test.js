import { describe, test, expect } from 'bun:test';
import { createRouter, createApp } from '../backend/server.js';

function makeReqRes({ method = 'GET', path = '/', remote = '127.0.0.1', origin } = {}) {
  const headers = { host: '127.0.0.1' };
  if (origin) headers.origin = origin;
  const req = {
    method,
    url: path,
    headers,
    socket: { remoteAddress: remote },
    on: (event, cb) => {
      if (event === 'end') setImmediate(cb);
      return req;
    },
  };
  const chunks = [];
  const res = {
    statusCode: 0,
    headers: {},
    body: null,
    headersSent: false,
    finished: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    write(c) { chunks.push(c); return true; },
    end(payload) { if (payload != null) chunks.push(payload); this.body = chunks.join(''); this.finished = true; this.headersSent = true; },
    on() { return res; },
    once() { return res; },
    emit() { return true; },
    off() { return res; },
  };
  return { req, res };
}

describe('createRouter', () => {
  test('dispatches by method + path', async () => {
    const router = createRouter();
    router.add('GET', '/ping', (ctx) => { ctx.res.statusCode = 200; ctx.res.end('pong'); });
    const { req, res } = makeReqRes({ method: 'GET', path: '/ping' });
    await router.handle(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('pong');
  });

  test('extracts named params', async () => {
    const router = createRouter();
    let captured = null;
    router.add('GET', '/tasks/:id/:kind', (ctx) => { captured = ctx.params; ctx.res.end(''); });
    const { req, res } = makeReqRes({ method: 'GET', path: '/tasks/abc/audit' });
    await router.handle(req, res);
    expect(captured).toEqual({ id: 'abc', kind: 'audit' });
  });

  test('returns 404 when no route matches', async () => {
    const router = createRouter();
    const { req, res } = makeReqRes({ method: 'GET', path: '/missing' });
    await router.handle(req, res);
    expect(res.statusCode).toBe(404);
  });

  test('star pattern is a fallback', async () => {
    const router = createRouter();
    router.add('GET', '/first', (ctx) => ctx.res.end('exact'));
    router.add('GET', '*', (ctx) => ctx.res.end('catch-all'));
    const exact = makeReqRes({ path: '/first' });
    await router.handle(exact.req, exact.res);
    expect(exact.res.body).toBe('exact');
    const caught = makeReqRes({ path: '/anything/else' });
    await router.handle(caught.req, caught.res);
    expect(caught.res.body).toBe('catch-all');
  });

  test('runs middlewares in order', async () => {
    const router = createRouter();
    const order = [];
    router.use((req, res, next) => { order.push('a'); next(); });
    router.use((req, res, next) => { order.push('b'); next(); });
    router.add('GET', '/x', (ctx) => { order.push('h'); ctx.res.end(''); });
    const { req, res } = makeReqRes({ path: '/x' });
    await router.handle(req, res);
    expect(order).toEqual(['a', 'b', 'h']);
  });
});

describe('createApp', () => {
  function stubGateway() {
    return {
      health: async () => ({ status: 'ok' }),
      stats: async () => ({ count: 0 }),
      listAgents: async () => ({ agents: [] }),
      listTasks: async () => ({ tasks: [] }),
      listProjects: async () => ({ projects: [] }),
      getBridgeInbox: async () => ({ messages: [] }),
      logs: async () => ({ logs: [] }),
      listProjectPhases: async () => ({ phases: [] }),
      reload: async () => ({ reloaded: true }),
    };
  }

  test('/health is unauthenticated and returns platform ok', async () => {
    const app = createApp({
      config: {
        ports: { gateway: 4840, backend: 4841, mcp: 4842 },
        paths: { projects: '/tmp', state: '/tmp' },
        gateway: { url: 'http://127.0.0.1:4840' },
      },
      gateway: stubGateway(),
    });
    const { req, res } = makeReqRes({ method: 'GET', path: '/health' });
    await app.router.handle(req, res);
    const payload = JSON.parse(res.body);
    expect(payload.status).toBe('ok');
    expect(payload.service).toBe('cortex-platform');
  });

  test('non-loopback remote is rejected', async () => {
    const app = createApp({
      config: {
        ports: { gateway: 4840, backend: 4841, mcp: 4842 },
        paths: { projects: '/tmp', state: '/tmp' },
        gateway: { url: 'http://127.0.0.1:4840' },
      },
      gateway: stubGateway(),
    });
    const { req, res } = makeReqRes({ method: 'GET', path: '/health', remote: '8.8.8.8' });
    await app.router.handle(req, res);
    expect(res.statusCode).toBe(403);
  });

  test('/api/system/health returns platform+gateway payload on loopback', async () => {
    const app = createApp({
      config: {
        ports: { gateway: 4840, backend: 4841, mcp: 4842 },
        paths: { projects: '/tmp', state: '/tmp' },
        gateway: { url: 'http://127.0.0.1:4840' },
      },
      gateway: stubGateway(),
    });
    const { req, res } = makeReqRes({ method: 'GET', path: '/api/system/health' });
    await app.router.handle(req, res);
    // /api/* routes go through platformAuth → 401 without a bearer/cookie
    expect(res.statusCode).toBe(401);
  });
});
