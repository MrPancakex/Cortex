/**
 * Additional coverage for platform/backend/server.js
 * Targets the uncovered branches at ~67%:
 *   - readJsonBodyIfNeeded: POST with body, invalid JSON → 400, empty body
 *   - middleware error path: mw throws → 500 JSON
 *   - handler error path: route handler throws → 500 JSON
 *   - star-route handler throws
 *   - headersSent guard in 404 path
 *   - URL-encoded path params (decodeURIComponent)
 *   - 404 JSON shape
 */
import { describe, test, expect } from 'bun:test';
import { createRouter } from '../backend/server.js';

/**
 * Build a minimal req/res pair.
 * `bodyChunks` — if provided, fires 'data' events before 'end'.
 */
function makeReqRes({
  method = 'GET',
  path = '/',
  remote = '127.0.0.1',
  bodyChunks = null,
} = {}) {
  const headers = { host: '127.0.0.1' };
  const listeners = {};
  const req = {
    method,
    url: path,
    headers,
    socket: { remoteAddress: remote },
    on(event, cb) {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
      // Schedule emission so the caller's await completes first
      if (event === 'end' && !bodyChunks) setImmediate(cb);
      if (event === 'end' && bodyChunks) {
        setImmediate(() => {
          const dataListeners = listeners['data'] || [];
          for (const chunk of bodyChunks) {
            for (const dl of dataListeners) dl(Buffer.from(chunk));
          }
          for (const el of listeners['end'] || []) el();
        });
      }
      return req;
    },
  };
  const acc = [];
  const res = {
    statusCode: 0,
    headers: {},
    body: null,
    headersSent: false,
    finished: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    write(c) { acc.push(c); return true; },
    end(payload) {
      if (payload != null) acc.push(payload);
      this.body = acc.join('');
      this.finished = true;
      this.headersSent = true;
    },
    on() { return res; },
    once() { return res; },
    emit() { return true; },
    off() { return res; },
  };
  return { req, res };
}

// ─── readJsonBodyIfNeeded via router ────────────────────────────────────────

describe('createRouter — body parsing', () => {
  test('should pass parsed JSON body to handler when POST has valid JSON', async () => {
    const router = createRouter();
    let captured = null;
    router.add('POST', '/data', (ctx) => {
      captured = ctx.body;
      ctx.res.statusCode = 200;
      ctx.res.end('ok');
    });
    const { req, res } = makeReqRes({
      method: 'POST',
      path: '/data',
      bodyChunks: ['{"hello":"world"}'],
    });
    await router.handle(req, res);
    expect(captured).toEqual({ hello: 'world' });
  });

  test('should split chunks and still parse valid JSON body', async () => {
    const router = createRouter();
    let captured = null;
    router.add('PUT', '/item', (ctx) => {
      captured = ctx.body;
      ctx.res.end('');
    });
    const { req, res } = makeReqRes({
      method: 'PUT',
      path: '/item',
      bodyChunks: ['{"a":', '"b"}'],
    });
    await router.handle(req, res);
    expect(captured).toEqual({ a: 'b' });
  });

  test('should return 400 and server_error when body is invalid JSON', async () => {
    const router = createRouter();
    router.add('POST', '/bad', (ctx) => { ctx.res.end('should not reach'); });
    const { req, res } = makeReqRes({
      method: 'POST',
      path: '/bad',
      bodyChunks: ['{not json}'],
    });
    await router.handle(req, res);
    expect(res.statusCode).toBe(400);
    const payload = JSON.parse(res.body);
    expect(payload.error).toBe('server_error');
    expect(payload.message).toBe('invalid json');
  });

  test('should pass null body to handler when POST body is empty', async () => {
    const router = createRouter();
    let captured = 'sentinel';
    router.add('POST', '/empty', (ctx) => {
      captured = ctx.body;
      ctx.res.end('');
    });
    const { req, res } = makeReqRes({
      method: 'POST',
      path: '/empty',
      bodyChunks: [],
    });
    await router.handle(req, res);
    expect(captured).toBeNull();
  });

  test('should pass null body for GET requests without reading body', async () => {
    const router = createRouter();
    let captured = 'sentinel';
    router.add('GET', '/get', (ctx) => {
      captured = ctx.body;
      ctx.res.end('');
    });
    const { req, res } = makeReqRes({ method: 'GET', path: '/get' });
    await router.handle(req, res);
    expect(captured).toBeNull();
  });

  test('should pass null body for DELETE requests', async () => {
    const router = createRouter();
    let captured = 'sentinel';
    router.add('DELETE', '/thing', (ctx) => {
      captured = ctx.body;
      ctx.res.end('');
    });
    const { req, res } = makeReqRes({ method: 'DELETE', path: '/thing' });
    await router.handle(req, res);
    expect(captured).toBeNull();
  });

  test('should pass null body for HEAD requests', async () => {
    const router = createRouter();
    let captured = 'sentinel';
    router.add('HEAD', '/h', (ctx) => {
      captured = ctx.body;
      ctx.res.end('');
    });
    const { req, res } = makeReqRes({ method: 'HEAD', path: '/h' });
    await router.handle(req, res);
    expect(captured).toBeNull();
  });
});

// ─── middleware error path ───────────────────────────────────────────────────

describe('createRouter — middleware error handling', () => {
  test('should return 500 JSON when middleware throws synchronously', async () => {
    const router = createRouter();
    router.use(() => { throw new Error('mw boom'); });
    router.add('GET', '/safe', (ctx) => ctx.res.end('should not reach'));
    const { req, res } = makeReqRes({ path: '/safe' });
    await router.handle(req, res);
    expect(res.statusCode).toBe(500);
    const payload = JSON.parse(res.body);
    expect(payload.error).toBe('server_error');
    expect(payload.message).toBe('mw boom');
  });

  test('should return statusCode from error when middleware sets it', async () => {
    const router = createRouter();
    router.use(() => {
      const err = new Error('teapot');
      err.statusCode = 418;
      throw err;
    });
    const { req, res } = makeReqRes({ path: '/x' });
    await router.handle(req, res);
    expect(res.statusCode).toBe(418);
  });

  test('should return 500 when middleware calls next(err)', async () => {
    const router = createRouter();
    router.use((req, res, next) => next(new Error('next err')));
    router.add('GET', '/y', (ctx) => ctx.res.end('ok'));
    const { req, res } = makeReqRes({ path: '/y' });
    await router.handle(req, res);
    expect(res.statusCode).toBe(500);
  });

  test('should not overwrite response when headers already sent on error', async () => {
    const router = createRouter();
    router.use((req, res, next) => {
      res.statusCode = 200;
      res.end('already sent');
      next(new Error('late error'));
    });
    const { req, res } = makeReqRes({ path: '/z' });
    await router.handle(req, res);
    // headersSent is true, so error middleware must not overwrite
    expect(res.body).toBe('already sent');
    expect(res.statusCode).toBe(200);
  });
});

// ─── route handler error path ────────────────────────────────────────────────

describe('createRouter — handler error handling', () => {
  test('should return 500 JSON when route handler throws', async () => {
    const router = createRouter();
    router.add('GET', '/boom', () => { throw new Error('handler fail'); });
    const { req, res } = makeReqRes({ path: '/boom' });
    await router.handle(req, res);
    expect(res.statusCode).toBe(500);
    const payload = JSON.parse(res.body);
    expect(payload.error).toBe('server_error');
  });

  test('should use error.statusCode from handler throw', async () => {
    const router = createRouter();
    router.add('GET', '/custom', () => {
      const err = new Error('bad input');
      err.statusCode = 422;
      throw err;
    });
    const { req, res } = makeReqRes({ path: '/custom' });
    await router.handle(req, res);
    expect(res.statusCode).toBe(422);
  });

  test('should return 500 when star-route handler throws', async () => {
    const router = createRouter();
    router.add('GET', '*', () => { throw new Error('star fail'); });
    const { req, res } = makeReqRes({ path: '/whatever' });
    await router.handle(req, res);
    expect(res.statusCode).toBe(500);
  });
});

// ─── 404 path ────────────────────────────────────────────────────────────────

describe('createRouter — 404', () => {
  test('should return 404 JSON with error not_found', async () => {
    const router = createRouter();
    const { req, res } = makeReqRes({ path: '/no-route' });
    await router.handle(req, res);
    expect(res.statusCode).toBe(404);
    const payload = JSON.parse(res.body);
    expect(payload.error).toBe('not_found');
  });

  test('should not double-respond when headersSent is true at 404 path', async () => {
    const router = createRouter();
    // A middleware that responds and does NOT call next — router should
    // see headersSent=true and skip the 404 branch.
    router.use((req, res) => {
      res.statusCode = 200;
      res.end('mw handled');
      // deliberately does not call next
    });
    const { req, res } = makeReqRes({ path: '/no-route' });
    await router.handle(req, res);
    expect(res.body).toBe('mw handled');
    expect(res.statusCode).toBe(200);
  });
});

// ─── URL-encoded params ──────────────────────────────────────────────────────

describe('createRouter — URL-encoded path params', () => {
  test('should decode percent-encoded path segment into params', async () => {
    const router = createRouter();
    let captured = null;
    router.add('GET', '/items/:name', (ctx) => {
      captured = ctx.params.name;
      ctx.res.end('');
    });
    const { req, res } = makeReqRes({ path: '/items/hello%20world' });
    await router.handle(req, res);
    expect(captured).toBe('hello world');
  });
});

// ─── method mismatch ─────────────────────────────────────────────────────────

describe('createRouter — method mismatch', () => {
  test('should return 404 when method does not match registered route', async () => {
    const router = createRouter();
    router.add('POST', '/only-post', (ctx) => ctx.res.end('ok'));
    const { req, res } = makeReqRes({ method: 'GET', path: '/only-post' });
    await router.handle(req, res);
    expect(res.statusCode).toBe(404);
  });
});
