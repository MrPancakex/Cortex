/**
 * Tests for sdk/auth/generate-token.js
 * Covers: missing sub, agent token (no file), admin token (file written), correct mode
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateToken } from '../../auth/generate-token.js';
import { rotateIdentity } from '../../auth/identity.js';
import { verifyToken } from '../../auth/verify.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-gentoken-test-'));

beforeAll(() => {
  // Bootstrap an identity so signToken can find a secret
  rotateIdentity({ root: ROOT });
  process.env.CORTEX_STATE_ROOT = ROOT;
});

afterAll(() => {
  delete process.env.CORTEX_STATE_ROOT;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('generateToken', () => {
  test('should throw when sub is missing', async () => {
    await expect(generateToken({ kind: 'agent', root: ROOT })).rejects.toThrow('sub required');
  });

  test('should return a signed token string for agent kind', async () => {
    const token = await generateToken({ kind: 'agent', sub: 'test-agent', root: ROOT });
    expect(typeof token).toBe('string');
    expect(token.split('.').length).toBe(3);
  });

  test('should produce a token that verifies correctly for agent kind', async () => {
    const token = await generateToken({ kind: 'agent', sub: 'verify-me', root: ROOT });
    const claims = await verifyToken(token);
    expect(claims.sub).toBe('verify-me');
    expect(claims.kind).toBe('agent');
  });

  test('should write admin.token file for admin kind', async () => {
    const dir = path.join(ROOT, 'admin-out');
    await generateToken({ kind: 'admin', sub: 'root', root: dir });
    const tokenPath = path.join(dir, 'admin.token');
    expect(fs.existsSync(tokenPath)).toBe(true);
  });

  test('should write admin.token with mode 0o600', async () => {
    const dir = path.join(ROOT, 'admin-mode');
    await generateToken({ kind: 'admin', sub: 'root', root: dir });
    const tokenPath = path.join(dir, 'admin.token');
    const stat = fs.statSync(tokenPath);
    // mode & 0o777 masks off the file type bits
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test('should not create admin.token file for agent kind', async () => {
    const dir = path.join(ROOT, 'agent-no-file');
    fs.mkdirSync(dir, { recursive: true });
    await generateToken({ kind: 'agent', sub: 'nova', root: dir });
    expect(fs.existsSync(path.join(dir, 'admin.token'))).toBe(false);
  });

  test('should apply custom ttlMs to the token expiry', async () => {
    const before = Date.now();
    const token = await generateToken({ kind: 'agent', sub: 'ttl-test', ttlMs: 60_000, root: ROOT });
    const claims = await verifyToken(token);
    const after = Date.now();
    expect(claims.exp).toBeGreaterThanOrEqual(before + 60_000);
    expect(claims.exp).toBeLessThanOrEqual(after + 60_000);
  });
});
