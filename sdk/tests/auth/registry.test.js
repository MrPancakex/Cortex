/**
 * Tests for sdk/auth/registry.js
 * Covers: registerAgent, findAgent, listAgents, revokeAgent,
 *         JSON hydration, corrupt stored JSON fallback
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registerAgent, findAgent, listAgents, revokeAgent } from '../../auth/registry.js';
import { resetDbForTests } from '../../db/test-helpers.js';
import { runMigrations } from '../../db/migrations/index.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-registry-test-'));
const DB_PATH = path.join(ROOT, 'registry-test.db');

beforeAll(() => {
  resetDbForTests();
  process.env.CORTEX_DB_PATH = DB_PATH;
  runMigrations();
});

afterAll(() => {
  resetDbForTests();
  delete process.env.CORTEX_DB_PATH;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('registerAgent', () => {
  test('should insert and return the agent with hydrated fields', () => {
    const agent = registerAgent({
      id: 'reg-agent-1',
      name: 'Reg One',
      kind: 'coder',
      capabilities: ['code', 'review'],
      model: 'claude-sonnet',
      provider: 'anthropic',
      metadata: { region: 'us' },
    });
    expect(agent.id).toBe('reg-agent-1');
    expect(agent.name).toBe('Reg One');
    expect(agent.status).toBe('online');
    expect(Array.isArray(agent.capabilities)).toBe(true);
    expect(agent.capabilities).toContain('code');
    expect(agent.metadata.region).toBe('us');
  });

  test('should upsert an existing agent (update name/kind, reset status to online)', () => {
    registerAgent({ id: 'upsert-agent', name: 'First', kind: 'coder' });
    revokeAgent('upsert-agent');
    const updated = registerAgent({ id: 'upsert-agent', name: 'Second', kind: 'reviewer' });
    expect(updated.name).toBe('Second');
    expect(updated.status).toBe('online');
  });

  test('should default capabilities to empty array when not provided', () => {
    const agent = registerAgent({ id: 'no-caps', name: 'No Caps', kind: 'ops' });
    expect(agent.capabilities).toEqual([]);
  });

  test('should default metadata to empty object when not provided', () => {
    const agent = registerAgent({ id: 'no-meta', name: 'No Meta', kind: 'ops' });
    expect(agent.metadata).toEqual({});
  });
});

describe('findAgent', () => {
  test('should return null when agent does not exist', () => {
    const result = findAgent('does-not-exist-xyz');
    expect(result).toBeNull();
  });

  test('should return hydrated agent when it exists', () => {
    registerAgent({ id: 'find-me', name: 'Find Me', kind: 'coder' });
    const agent = findAgent('find-me');
    expect(agent).not.toBeNull();
    expect(agent.id).toBe('find-me');
    expect(Array.isArray(agent.capabilities)).toBe(true);
    expect(typeof agent.metadata).toBe('object');
  });
});

describe('listAgents', () => {
  test('should return an array', () => {
    const agents = listAgents();
    expect(Array.isArray(agents)).toBe(true);
  });

  test('should filter by status', () => {
    registerAgent({ id: 'online-1', name: 'Online One', kind: 'coder' });
    registerAgent({ id: 'offline-1', name: 'Offline One', kind: 'coder' });
    revokeAgent('offline-1');
    const online = listAgents({ status: 'online' });
    const disabled = listAgents({ status: 'disabled' });
    expect(online.every((a) => a.status === 'online')).toBe(true);
    expect(disabled.every((a) => a.status === 'disabled')).toBe(true);
  });

  test('should filter by kind', () => {
    registerAgent({ id: 'kind-ops-1', name: 'Ops', kind: 'ops' });
    const ops = listAgents({ kind: 'ops' });
    expect(ops.every((a) => a.kind === 'ops')).toBe(true);
  });

  test('should filter by both status and kind', () => {
    registerAgent({ id: 'combo-coder', name: 'Combo', kind: 'coder' });
    const results = listAgents({ status: 'online', kind: 'coder' });
    expect(results.every((a) => a.kind === 'coder' && a.status === 'online')).toBe(true);
  });
});

describe('revokeAgent', () => {
  test('should set status to disabled', () => {
    registerAgent({ id: 'revoke-me', name: 'Revoke', kind: 'coder' });
    revokeAgent('revoke-me');
    const agent = findAgent('revoke-me');
    expect(agent.status).toBe('disabled');
  });
});
