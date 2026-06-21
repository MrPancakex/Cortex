/**
 * Tests for sdk/http/client.js — gatewayFetch S4 home.
 *
 * Covers:
 *   1. A successful 2xx response returns parsed JSON.
 *   2. A !ok response throws a typed GatewayError (not a silent return).
 *   3. GatewayError carries status + body from the upstream response.
 *   4. A network-level error (fetch rejects) propagates as a plain Error,
 *      not swallowed.
 */
import { describe, test, expect } from 'bun:test';
import { gatewayFetch, GatewayError } from '../../http/client.js';

/**
 * Build a minimal fetch stub that returns a fixed status + JSON body.
 */
function makeFetch({ status, body, ok = status >= 200 && status < 300 }) {
  return async (_url, _init) => ({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    text: async () => JSON.stringify(body),
  });
}

/**
 * Build a fetch stub that rejects with a network error.
 */
function makeNetworkErrorFetch(message = 'ECONNREFUSED') {
  return async (_url, _init) => { throw Object.assign(new Error(message), { code: 'ECONNREFUSED' }); };
}

// Patch the global fetch with a stub for the duration of each test.
async function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

describe('gatewayFetch', () => {
  test('returns parsed JSON on 2xx', async () => {
    const result = await withFetch(
      makeFetch({ status: 200, body: { ok: true, id: 'abc' } }),
      () => gatewayFetch('http://localhost:4840/v1/api/health'),
    );
    expect(result).toEqual({ ok: true, id: 'abc' });
  });

  test('throws GatewayError on !ok response (not a silent pass)', async () => {
    let threw = null;
    try {
      await withFetch(
        makeFetch({ status: 404, body: { error: 'not_found' }, ok: false }),
        () => gatewayFetch('http://localhost:4840/v1/api/tasks/missing'),
      );
    } catch (err) {
      threw = err;
    }
    expect(threw).not.toBeNull();
    expect(threw).toBeInstanceOf(GatewayError);
  });

  test('GatewayError.status equals the HTTP status code', async () => {
    let threw = null;
    try {
      await withFetch(
        makeFetch({ status: 403, body: { error: 'forbidden' }, ok: false }),
        () => gatewayFetch('http://localhost:4840/v1/api/tasks/x'),
      );
    } catch (err) {
      threw = err;
    }
    expect(threw?.status).toBe(403);
  });

  test('GatewayError.body carries the parsed upstream body', async () => {
    let threw = null;
    try {
      await withFetch(
        makeFetch({ status: 422, body: { error: 'validation_failed', field: 'title' }, ok: false }),
        () => gatewayFetch('http://localhost:4840/v1/api/tasks', { method: 'POST', body: {} }),
      );
    } catch (err) {
      threw = err;
    }
    expect(threw?.body).toEqual({ error: 'validation_failed', field: 'title' });
  });

  test('GatewayError message is taken from body.error', async () => {
    let threw = null;
    try {
      await withFetch(
        makeFetch({ status: 400, body: { error: 'bad_request' }, ok: false }),
        () => gatewayFetch('http://localhost:4840/v1/api/tasks'),
      );
    } catch (err) {
      threw = err;
    }
    expect(threw?.message).toBe('bad_request');
  });

  test('injects x-cortex-token header when token provided', async () => {
    let capturedHeaders = null;
    globalThis.fetch = async (_url, init) => {
      capturedHeaders = init.headers;
      return { ok: true, status: 200, statusText: 'OK', text: async () => '{}' };
    };
    try {
      await gatewayFetch('http://localhost:4840/v1/api/health', { token: 'mytoken123' });
    } finally {
      delete globalThis.fetch;
    }
    expect(capturedHeaders?.['x-cortex-token']).toBe('mytoken123');
  });

  test('network error (fetch rejection) propagates as plain Error, not swallowed', async () => {
    let threw = null;
    try {
      await withFetch(
        makeNetworkErrorFetch('connect ECONNREFUSED 127.0.0.1:4840'),
        () => gatewayFetch('http://localhost:4840/v1/api/health'),
      );
    } catch (err) {
      threw = err;
    }
    expect(threw).not.toBeNull();
    // Network errors are NOT GatewayErrors — they are plain Errors from fetch rejection.
    expect(threw instanceof GatewayError).toBe(false);
  });
});
