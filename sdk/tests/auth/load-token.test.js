/**
 * Tests for sdk/auth/load-token.js and sdk/auth/load-admin-token.js
 * Covers: ENOENT (null), happy path, corrupt file (still returns content), env override
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadToken } from '../../auth/load-token.js';
import { loadAdminToken } from '../../auth/load-admin-token.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-loadtoken-test-'));

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('loadToken', () => {
  test('should return null when the token file does not exist', () => {
    const result = loadToken('missing.token', { root: path.join(ROOT, 'empty') });
    expect(result).toBeNull();
  });

  test('should return the token string when file exists', () => {
    const dir = path.join(ROOT, 'has-token');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.token'), 'tok-abc123\n');
    const result = loadToken('agent.token', { root: dir });
    expect(result).toBe('tok-abc123');
  });

  test('should trim whitespace from the token', () => {
    const dir = path.join(ROOT, 'whitespace');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ws.token'), '  tok-padded  \n');
    const result = loadToken('ws.token', { root: dir });
    expect(result).toBe('tok-padded');
  });

  test('should return null and swallow non-ENOENT errors gracefully', () => {
    // Provide a directory as the file path to trigger EISDIR (not ENOENT)
    const dir = path.join(ROOT, 'eisdir');
    fs.mkdirSync(dir, { recursive: true });
    // Create a sub-directory named like the token file so readFileSync gets EISDIR
    fs.mkdirSync(path.join(dir, 'bad.token'), { recursive: true });
    // Should not throw — swallow() handles it
    const result = loadToken('bad.token', { root: dir });
    expect(result).toBeNull();
  });
});

describe('loadAdminToken', () => {
  test('should return env var when CORTEX_ADMIN_TOKEN is set', () => {
    const original = process.env.CORTEX_ADMIN_TOKEN;
    process.env.CORTEX_ADMIN_TOKEN = 'env-tok-xyz';
    try {
      const result = loadAdminToken({ root: path.join(ROOT, 'unused') });
      expect(result).toBe('env-tok-xyz');
    } finally {
      if (original === undefined) delete process.env.CORTEX_ADMIN_TOKEN;
      else process.env.CORTEX_ADMIN_TOKEN = original;
    }
  });

  test('should fall through to file when env var is not set', () => {
    const original = process.env.CORTEX_ADMIN_TOKEN;
    delete process.env.CORTEX_ADMIN_TOKEN;
    const dir = path.join(ROOT, 'admin-file');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'admin.token'), 'file-admin-tok');
    try {
      const result = loadAdminToken({ root: dir });
      expect(result).toBe('file-admin-tok');
    } finally {
      if (original !== undefined) process.env.CORTEX_ADMIN_TOKEN = original;
    }
  });

  test('should return null when env not set and file absent', () => {
    const original = process.env.CORTEX_ADMIN_TOKEN;
    delete process.env.CORTEX_ADMIN_TOKEN;
    try {
      const result = loadAdminToken({ root: path.join(ROOT, 'no-admin') });
      expect(result).toBeNull();
    } finally {
      if (original !== undefined) process.env.CORTEX_ADMIN_TOKEN = original;
    }
  });
});
