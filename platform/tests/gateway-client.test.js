import { describe, test, expect } from 'bun:test';
import {
  createGatewayClient,
  classifyFetchError,
} from '../backend/lib/gateway-client.js';

function makeStubFetch(responses) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init = {}) => {
      const match = responses.find((r) => r.match(url, init));
      if (!match) throw new Error(`no stub matched ${url}`);
      calls.push({ url: url.toString(), method: init.method || 'GET', headers: init.headers, body: init.body });
      if (match.throws) throw Object.assign(new Error('network'), match.throws);
      return new Response(match.body ?? null, {
        status: match.status ?? 200,
        headers: match.headers || { 'content-type': 'application/json' },
      });
    },
  };
}

describe('classifyFetchError', () => {
  test('maps node error codes to stable envelopes', () => {
    expect(classifyFetchError({ code: 'ECONNREFUSED' })).toMatchObject({
      error: 'gateway_offline', status: 502,
    });
    expect(classifyFetchError({ code: 'ETIMEDOUT' })).toMatchObject({
      error: 'gateway_timeout', status: 504,
    });
    expect(classifyFetchError({ code: 'ENOTFOUND' })).toMatchObject({
      error: 'gateway_unreachable', status: 502,
    });
    expect(classifyFetchError({ code: 'EUNKNOWN', message: 'boom' })).toMatchObject({
      error: 'proxy_unknown', status: 500, message: 'boom',
    });
  });

  test('unwraps err.cause.code when top-level code is missing', () => {
    expect(classifyFetchError({ cause: { code: 'ECONNREFUSED' } })).toMatchObject({
      error: 'gateway_offline',
    });
  });
});

describe('createGatewayClient', () => {
  test('requires baseUrl', () => {
    expect(() => createGatewayClient({})).toThrow(/baseUrl required/);
  });

  test('health() sends bearer + legacy token header', async () => {
    const stub = makeStubFetch([
      { match: (u) => u.pathname === '/v1/api/health', body: JSON.stringify({ ok: true }) },
    ]);
    const client = createGatewayClient({
      baseUrl: 'http://127.0.0.1:4840',
      tokenLoader: () => 'test-token',
      fetchImpl: stub.fetch,
    });
    const result = await client.health();
    expect(result).toEqual({ ok: true });
    expect(stub.calls[0].headers.authorization).toBe('Bearer test-token');
    expect(stub.calls[0].headers['x-cortex-token']).toBe('test-token');
  });

  test('listTasks() serializes query string', async () => {
    const stub = makeStubFetch([
      { match: (u) => u.pathname === '/v1/api/tasks' && u.searchParams.get('status') === 'pending',
        body: JSON.stringify({ tasks: [] }) },
    ]);
    const client = createGatewayClient({
      baseUrl: 'http://127.0.0.1:4840',
      tokenLoader: () => null,
      fetchImpl: stub.fetch,
    });
    const out = await client.listTasks({ status: 'pending' });
    expect(out).toEqual({ tasks: [] });
  });

  test('getTask() URL-encodes the id', async () => {
    const stub = makeStubFetch([
      { match: (u) => u.pathname === '/v1/api/tasks/abc%2Fdef', body: JSON.stringify({ id: 'abc/def' }) },
    ]);
    const client = createGatewayClient({
      baseUrl: 'http://127.0.0.1:4840',
      tokenLoader: () => null,
      fetchImpl: stub.fetch,
    });
    const task = await client.getTask('abc/def');
    expect(task.id).toBe('abc/def');
  });

  test('non-ok response throws with statusCode + detail', async () => {
    const stub = makeStubFetch([
      { match: (u) => u.pathname === '/v1/api/tasks',
        status: 400,
        body: JSON.stringify({ error: 'bad_request', message: 'missing title' }) },
    ]);
    const client = createGatewayClient({
      baseUrl: 'http://127.0.0.1:4840',
      tokenLoader: () => null,
      fetchImpl: stub.fetch,
    });
    try {
      await client.listTasks();
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.statusCode).toBe(400);
      expect(err.detail).toEqual({ error: 'bad_request', message: 'missing title' });
    }
  });

  test('non-JSON response throws upstream_non_json', async () => {
    const stub = makeStubFetch([
      { match: (u) => u.pathname === '/v1/api/health',
        status: 200,
        body: '<html>oops</html>',
        headers: { 'content-type': 'text/html' } },
    ]);
    const client = createGatewayClient({
      baseUrl: 'http://127.0.0.1:4840',
      tokenLoader: () => null,
      fetchImpl: stub.fetch,
    });
    try {
      await client.health();
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.statusCode).toBe(502);
      expect(err.detail.error).toBe('upstream_non_json');
      expect(err.detail.snippet).toContain('<html>');
    }
  });

  test('fetch rejection throws classified error', async () => {
    const stub = makeStubFetch([
      { match: () => true, throws: { code: 'ECONNREFUSED' } },
    ]);
    const client = createGatewayClient({
      baseUrl: 'http://127.0.0.1:4840',
      tokenLoader: () => null,
      fetchImpl: stub.fetch,
    });
    try {
      await client.health();
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.statusCode).toBe(502);
      expect(err.detail.error).toBe('gateway_offline');
    }
  });

  test('POST sends JSON body', async () => {
    const stub = makeStubFetch([
      { match: (u, init) => u.pathname === '/v1/api/bridge/send' && init.method === 'POST',
        body: JSON.stringify({ id: 'msg-1' }) },
    ]);
    const client = createGatewayClient({
      baseUrl: 'http://127.0.0.1:4840',
      tokenLoader: () => 'tok',
      fetchImpl: stub.fetch,
    });
    const result = await client.sendBridge({ to: 'nova', content: 'hi' });
    expect(result).toEqual({ id: 'msg-1' });
    expect(stub.calls[0].body).toBe(JSON.stringify({ to: 'nova', content: 'hi' }));
  });
});
