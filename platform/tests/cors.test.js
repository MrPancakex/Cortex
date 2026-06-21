import { describe, test, expect } from 'bun:test';
import { platformCors, DEFAULT_ORIGINS } from '../backend/middleware/cors.js';
import { PLATFORM_PORT } from '@cortex/core/constants';

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    end(payload) {
      this.body = payload || null;
    },
  };
}

describe('platformCors', () => {
  test('reflects allowed origin', () => {
    const mw = platformCors();
    const res = makeRes();
    let nextCalled = false;
    mw(
      { method: 'GET', headers: { origin: `http://127.0.0.1:${PLATFORM_PORT}` } },
      res,
      () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(true);
    expect(res.headers['access-control-allow-origin']).toBe(`http://127.0.0.1:${PLATFORM_PORT}`);
  });

  test('does not reflect an unknown origin', () => {
    const mw = platformCors();
    const res = makeRes();
    let nextCalled = false;
    mw(
      { method: 'GET', headers: { origin: 'http://evil.example' } },
      res,
      () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(true);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('short-circuits OPTIONS with 204', () => {
    const mw = platformCors();
    const res = makeRes();
    let nextCalled = false;
    mw(
      { method: 'OPTIONS', headers: { origin: `http://localhost:${PLATFORM_PORT}` } },
      res,
      () => { nextCalled = true; },
    );
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(204);
  });

  test('DEFAULT_ORIGINS includes both loopback forms on PLATFORM_PORT', () => {
    expect(DEFAULT_ORIGINS).toContain(`http://localhost:${PLATFORM_PORT}`);
    expect(DEFAULT_ORIGINS).toContain(`http://127.0.0.1:${PLATFORM_PORT}`);
  });

  test('custom origins override the default', () => {
    const mw = platformCors({ origins: ['http://example.test'] });
    const res = makeRes();
    mw(
      { method: 'GET', headers: { origin: 'http://example.test' } },
      res,
      () => {},
    );
    expect(res.headers['access-control-allow-origin']).toBe('http://example.test');
  });
});
