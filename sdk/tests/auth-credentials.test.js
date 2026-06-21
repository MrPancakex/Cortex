import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  loadCredentials,
  saveCredentials,
  deleteCredential,
} from '../auth/credentials.js';

const ROOT = path.join(os.tmpdir(), `cortex-creds-test-${process.pid}`);

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('credential envelope — unencrypted path', () => {
  test('save + load round-trips a plain record', () => {
    saveCredentials(
      { id: 'openai-primary', kind: 'api_key', provider: 'openai', value: { key: 'sk-abc' } },
      { root: ROOT },
    );
    const loaded = loadCredentials({ root: ROOT });
    expect(loaded['openai-primary']?.value?.key).toBe('sk-abc');
    expect(loaded['openai-primary']?.encrypted).toBe(false);
  });

  test('deleteCredential removes a record', () => {
    saveCredentials(
      { id: 'removeme', kind: 'token', provider: 'cortex', value: { token: 't' } },
      { root: ROOT },
    );
    deleteCredential('removeme', { root: ROOT });
    expect(loadCredentials({ root: ROOT }).removeme).toBeUndefined();
  });
});

describe('credential envelope — GCM-encrypted path', () => {
  const PASSPHRASE = 'correct-horse-battery-staple';

  test('passphrase-wrapped record decrypts cleanly on the same passphrase', () => {
    saveCredentials(
      {
        id: 'anthropic-primary',
        kind: 'api_key',
        provider: 'anthropic',
        value: { key: 'sk-ant-live-xyz', scope: 'read-write' },
      },
      { passphrase: PASSPHRASE, root: ROOT },
    );
    const loaded = loadCredentials({ passphrase: PASSPHRASE, root: ROOT });
    expect(loaded['anthropic-primary']).toBeDefined();
    expect(loaded['anthropic-primary'].value).toEqual({
      key: 'sk-ant-live-xyz',
      scope: 'read-write',
    });
    // After decrypt the caller view must be flagged as in-the-clear so
    // downstream code doesn't try to decrypt twice.
    expect(loaded['anthropic-primary'].encrypted).toBe(false);
  });

  test('wrong passphrase fails authenticated decrypt (silent, counter bumped)', () => {
    saveCredentials(
      { id: 'gmk', kind: 'api_key', provider: 'google', value: { key: 'tst' } },
      { passphrase: PASSPHRASE, root: ROOT },
    );
    const loaded = loadCredentials({ passphrase: 'wrong-passphrase', root: ROOT });
    // Decrypt failed (swallowed) — no entry surfaced for the caller.
    expect(loaded.gmk).toBeUndefined();
  });

  test('auth_tag is persisted alongside ciphertext', () => {
    saveCredentials(
      { id: 'tagcheck', kind: 'api_key', provider: 'openai', value: { k: 1 } },
      { passphrase: PASSPHRASE, root: ROOT },
    );
    const envPath = path.join(ROOT, 'credentials.enc');
    const env = JSON.parse(fs.readFileSync(envPath, 'utf8'));
    expect(env.records.tagcheck.encrypted).toBe(true);
    expect(typeof env.records.tagcheck.auth_tag).toBe('string');
    expect(env.records.tagcheck.auth_tag.length).toBeGreaterThan(10);
  });

  test('loading an envelope without auth_tag is refused (pre-fix file)', () => {
    // Simulate a pre-fix envelope: encrypted record but no auth_tag field.
    const envPath = path.join(ROOT, 'credentials.enc');
    const poisoned = {
      version: 2,
      salt: Buffer.alloc(16, 1).toString('base64url'),
      records: {
        legacy: {
          id: 'legacy',
          kind: 'api_key',
          provider: 'openai',
          encrypted: true,
          nonce: Buffer.alloc(12, 2).toString('base64url'),
          ciphertext: Buffer.alloc(16, 3).toString('base64url'),
          created_at: '2026-01-01T00:00:00.000Z',
        },
      },
    };
    fs.writeFileSync(envPath, JSON.stringify(poisoned));
    const loaded = loadCredentials({ passphrase: PASSPHRASE, root: ROOT });
    expect(loaded.legacy).toBeUndefined();
  });
});
