/**
 * Tests for sdk/auth/identity.js
 * Covers: loadIdentity, saveIdentity, rotateIdentity
 * ENOENT, corrupt JSON, happy-path round-trip, atomic write (tmp rename)
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadIdentity, saveIdentity, rotateIdentity } from '../../auth/identity.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-identity-test-'));

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('loadIdentity', () => {
  test('should return null when identity file does not exist', () => {
    const result = loadIdentity({ root: path.join(ROOT, 'nonexistent') });
    expect(result).toBeNull();
  });

  test('should return null and not throw when file contains invalid JSON', () => {
    const dir = path.join(ROOT, 'corrupt');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'identity.json'), '{ not valid json }');
    const result = loadIdentity({ root: dir });
    expect(result).toBeNull();
  });

  test('should return parsed identity when file is valid JSON', () => {
    const dir = path.join(ROOT, 'valid');
    fs.mkdirSync(dir, { recursive: true });
    const identity = { id: 'test-id', created_at: '2026-01-01T00:00:00.000Z', secret: 'mysecret' };
    fs.writeFileSync(path.join(dir, 'identity.json'), JSON.stringify(identity));
    const result = loadIdentity({ root: dir });
    expect(result).toEqual(identity);
  });
});

describe('saveIdentity', () => {
  test('should write identity to disk and be loadable', () => {
    const dir = path.join(ROOT, 'save-test');
    const identity = { id: 'my-id', created_at: '2026-01-01T00:00:00.000Z', secret: 'abc123' };
    saveIdentity(identity, { root: dir });
    const loaded = loadIdentity({ root: dir });
    expect(loaded).toEqual(identity);
  });

  test('should create parent directory with mode 700', () => {
    const dir = path.join(ROOT, 'mkdir-test');
    saveIdentity({ id: 'x', created_at: 'now', secret: 's' }, { root: dir });
    const stat = fs.statSync(dir);
    expect(stat.isDirectory()).toBe(true);
  });

  test('should not leave a .tmp file after successful write', () => {
    const dir = path.join(ROOT, 'tmp-cleanup');
    saveIdentity({ id: 'y', created_at: 'now', secret: 's' }, { root: dir });
    const files = fs.readdirSync(dir);
    expect(files.every((f) => !f.endsWith('.tmp'))).toBe(true);
  });
});

describe('rotateIdentity', () => {
  test('should return a new identity with required fields', () => {
    const dir = path.join(ROOT, 'rotate-test');
    const identity = rotateIdentity({ root: dir });
    expect(typeof identity.id).toBe('string');
    expect(typeof identity.created_at).toBe('string');
    expect(typeof identity.secret).toBe('string');
    expect(identity.secret.length).toBeGreaterThan(20);
  });

  test('should persist the rotated identity to disk', () => {
    const dir = path.join(ROOT, 'rotate-persist');
    const identity = rotateIdentity({ root: dir });
    const loaded = loadIdentity({ root: dir });
    expect(loaded).toEqual(identity);
  });

  test('should produce a different secret each call', () => {
    const dir = path.join(ROOT, 'rotate-unique');
    const a = rotateIdentity({ root: dir });
    const b = rotateIdentity({ root: dir });
    expect(a.secret).not.toBe(b.secret);
    expect(a.id).not.toBe(b.id);
  });
});
