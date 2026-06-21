/**
 * Tests for sdk/auth/init.js (initAuth bootstrap)
 * Covers: fresh init, idempotent second call, force=true rotates identity
 *
 * IMPORTANT: generateToken → signToken → loadIdentity() with no root.
 * It reads from CORTEX_STATE_ROOT. We must point CORTEX_STATE_ROOT to the
 * same temp dir so signing can find the freshly created identity.
 */
import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initAuth } from '../../auth/init.js';
import { loadIdentity } from '../../auth/identity.js';

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-initauth-test-'));

afterAll(() => {
  delete process.env.CORTEX_STATE_ROOT;
  fs.rmSync(BASE, { recursive: true, force: true });
});

describe('initAuth', () => {
  test('should return identity and adminToken on first run', async () => {
    const root = path.join(BASE, 'first-run');
    process.env.CORTEX_STATE_ROOT = root;
    const result = await initAuth({ root });
    expect(result.identity).toBeDefined();
    expect(typeof result.identity.secret).toBe('string');
    expect(typeof result.adminToken).toBe('string');
  });

  test('should be idempotent — second call returns same identity', async () => {
    const root = path.join(BASE, 'idempotent');
    process.env.CORTEX_STATE_ROOT = root;
    const first = await initAuth({ root });
    const second = await initAuth({ root });
    expect(second.identity.id).toBe(first.identity.id);
    expect(second.identity.secret).toBe(first.identity.secret);
  });

  test('should persist identity to disk after init', async () => {
    const root = path.join(BASE, 'persist');
    process.env.CORTEX_STATE_ROOT = root;
    await initAuth({ root });
    const loaded = loadIdentity({ root });
    expect(loaded).not.toBeNull();
    expect(typeof loaded.id).toBe('string');
  });

  test('should rotate identity when force=true', async () => {
    const root = path.join(BASE, 'force');
    process.env.CORTEX_STATE_ROOT = root;
    const first = await initAuth({ root });
    const second = await initAuth({ root, force: true });
    expect(second.identity.id).not.toBe(first.identity.id);
  });

  test('should persist the new admin token file when initialized', async () => {
    const root = path.join(BASE, 'token-file');
    process.env.CORTEX_STATE_ROOT = root;
    await initAuth({ root });
    expect(fs.existsSync(path.join(root, 'admin.token'))).toBe(true);
  });
});
