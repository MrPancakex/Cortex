import { describe, test, expect } from 'bun:test';
import {
  assertLoopbackBinding,
  requireLoopback,
  parseCookie,
  platformAuth,
} from '../backend/middleware/auth.js';

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    headersSent: false,
    setHeader(k, v) { this.headers[k] = v; },
    end(payload) {
      this.body = payload;
      this.headersSent = true;
    },
  };
}

describe('assertLoopbackBinding', () => {
  test('accepts loopback hosts', () => {
    expect(() => assertLoopbackBinding('127.0.0.1')).not.toThrow();
    expect(() => assertLoopbackBinding('::1')).not.toThrow();
    expect(() => assertLoopbackBinding('localhost')).not.toThrow();
  });

  test('throws on non-loopback', () => {
    expect(() => assertLoopbackBinding('0.0.0.0')).toThrow(/loopback/);
    expect(() => assertLoopbackBinding('10.0.0.1')).toThrow(/loopback/);
  });
});

describe('requireLoopback', () => {
  test('allows loopback remote', () => {
    const res = makeRes();
    let called = false;
    requireLoopback({ socket: { remoteAddress: '127.0.0.1' } }, res, () => { called = true; });
    expect(called).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  test('forbids non-loopback', () => {
    const res = makeRes();
    let called = false;
    requireLoopback({ socket: { remoteAddress: '1.2.3.4' } }, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  test('respects req.ip if set', () => {
    const res = makeRes();
    let called = false;
    requireLoopback({ ip: '::1', socket: {} }, res, () => { called = true; });
    expect(called).toBe(true);
  });
});

describe('parseCookie', () => {
  test('returns empty object on empty input', () => {
    expect(parseCookie('')).toEqual({});
    expect(parseCookie(undefined)).toEqual({});
  });

  test('parses multiple key=value pairs', () => {
    expect(parseCookie('a=1; b=two; c=hello%20world'))
      .toEqual({ a: '1', b: 'two', c: 'hello world' });
  });

  test('handles = in values', () => {
    expect(parseCookie('token=abc=def=ghi')).toEqual({ token: 'abc=def=ghi' });
  });

  test('skips empty keys', () => {
    expect(parseCookie(';=bad;a=1')).toEqual({ a: '1' });
  });
});

describe('platformAuth', () => {
  test('401s when no authorization header and no cookie', async () => {
    const res = makeRes();
    let called = false;
    await platformAuth({ headers: {} }, res, () => { called = true; });
    expect(called).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  test('401s when cookie token is invalid', async () => {
    const res = makeRes();
    let called = false;
    await platformAuth(
      { headers: { cookie: 'cortex_session=not-a-real-token' } },
      res,
      () => { called = true; },
    );
    expect(called).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});
