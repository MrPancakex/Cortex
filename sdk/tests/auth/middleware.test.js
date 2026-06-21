/**
 * Tests for sdk/auth/middleware.js
 * Covers: authMiddleware (missing token, bad scheme, bad token, valid token),
 *         requireAdmin (pass/fail), requireAgent (pass/disabled/not-found)
 *
 * Registry is backed by a real in-memory SQLite DB. We call resetDbForTests()
 * and runMigrations() before each suite to get a clean schema.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { authMiddleware, requireAdmin, requireAgent } from '../../auth/middleware.js';
import { signToken } from '../../auth/verify.js';
import { rotateIdentity } from '../../auth/identity.js';
import { registerAgent, revokeAgent } from '../../auth/registry.js';
import { resetDbForTests } from '../../db/test-helpers.js';
import { runMigrations } from '../../db/migrations/index.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-middleware-test-'));
const DB_PATH = path.join(ROOT, 'mw-test.db');
const SECRET = 'mw-test-secret';

/** Minimal mock res object that records what was written */
function mockRes() {
  const res = { statusCode: null, _body: null, _headers: {}, headersSent: false };
  res.setHeader = (k, v) => { res._headers[k] = v; };
  res.end = (body) => { res._body = body ?? null; res.headersSent = true; };
  return res;
}

function fakeReq(authorization) {
  return { headers: { authorization } };
}

beforeAll(() => {
  resetDbForTests();
  process.env.CORTEX_DB_PATH = DB_PATH;
  process.env.CORTEX_STATE_ROOT = ROOT;
  rotateIdentity({ root: ROOT });
  runMigrations();
});

afterAll(() => {
  resetDbForTests();
  delete process.env.CORTEX_DB_PATH;
  delete process.env.CORTEX_STATE_ROOT;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('authMiddleware', () => {
  test('should return 401 when Authorization header is missing', async () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = () => { throw new Error('next should not be called'); };
    await authMiddleware(req, res, next);
    expect(res.statusCode).toBe(401);
  });

  test('should return 401 when scheme is not Bearer', async () => {
    const req = fakeReq('Basic abc123');
    const res = mockRes();
    await authMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });

  test('should return 401 when token is missing after Bearer', async () => {
    const req = fakeReq('Bearer ');
    const res = mockRes();
    // 'Bearer '.split(' ') gives ['Bearer', ''] — empty string is falsy
    await authMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });

  test('should return 401 when token fails verification', async () => {
    const req = fakeReq('Bearer not.a.valid.token.here');
    const res = mockRes();
    await authMiddleware(req, res, () => {});
    expect(res.statusCode).toBe(401);
  });

  test('should call next and set req.auth when token is valid', async () => {
    const token = signToken({ kind: 'admin', sub: 'root' }, { secret: SECRET, ttlMs: 60_000 });
    // Re-generate with the actual identity secret
    const realToken = signToken({ kind: 'admin', sub: 'root' }, { ttlMs: 60_000 });
    const req = fakeReq(`Bearer ${realToken}`);
    const res = mockRes();
    let nextCalled = false;
    await authMiddleware(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    expect(req.auth).toBeDefined();
    expect(req.auth.kind).toBe('admin');
    expect(req.auth.id).toBe('root');
  });
});

describe('requireAdmin', () => {
  test('should return 403 when req.auth is missing', () => {
    const req = {};
    const res = mockRes();
    requireAdmin(req, res, () => {});
    expect(res.statusCode).toBe(403);
  });

  test('should return 403 when kind is agent not admin', () => {
    const req = { auth: { kind: 'agent', id: 'nova' } };
    const res = mockRes();
    requireAdmin(req, res, () => {});
    expect(res.statusCode).toBe(403);
  });

  test('should call next when kind is admin', () => {
    const req = { auth: { kind: 'admin', id: 'root' } };
    const res = mockRes();
    let called = false;
    requireAdmin(req, res, () => { called = true; });
    expect(called).toBe(true);
    expect(res.statusCode).toBeNull();
  });
});

describe('requireAgent', () => {
  test('should return 403 when req.auth is missing', () => {
    const req = {};
    const res = mockRes();
    requireAgent(req, res, () => {});
    expect(res.statusCode).toBe(403);
  });

  test('should return 403 when kind is not agent', () => {
    const req = { auth: { kind: 'admin', id: 'root' } };
    const res = mockRes();
    requireAgent(req, res, () => {});
    expect(res.statusCode).toBe(403);
  });

  test('should return 403 when agent is not found in registry', () => {
    const req = { auth: { kind: 'agent', id: 'ghost-agent-does-not-exist' } };
    const res = mockRes();
    requireAgent(req, res, () => {});
    expect(res.statusCode).toBe(403);
  });

  test('should return 403 when agent is disabled', () => {
    registerAgent({ id: 'disabled-agent', name: 'Disabled', kind: 'coder' });
    revokeAgent('disabled-agent');
    const req = { auth: { kind: 'agent', id: 'disabled-agent' } };
    const res = mockRes();
    requireAgent(req, res, () => {});
    expect(res.statusCode).toBe(403);
  });

  test('should call next and set req.agent when agent is active', () => {
    registerAgent({ id: 'active-agent', name: 'Active', kind: 'coder', capabilities: ['code'] });
    const req = { auth: { kind: 'agent', id: 'active-agent' } };
    const res = mockRes();
    let called = false;
    requireAgent(req, res, () => { called = true; });
    expect(called).toBe(true);
    expect(req.agent).toBeDefined();
    expect(req.agent.id).toBe('active-agent');
  });
});
