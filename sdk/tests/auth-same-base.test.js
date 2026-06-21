import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDb, runMigrations, resetDbForTests } from '../db/index.js';
import { registerAgent } from '../auth/registry.js';
import { resolveBaseAgent, sameBaseAgent } from '../auth/same-base.js';

const ROOT = path.join(os.tmpdir(), `cortex-same-base-${process.pid}`);
const DB_FILE = path.join(ROOT, 'same-base.db');

beforeEach(() => {
  resetDbForTests();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  process.env.CORTEX_DB_PATH = DB_FILE;
  getDb({ path: DB_FILE });
  runMigrations();
});

afterAll(() => {
  resetDbForTests();
  delete process.env.CORTEX_DB_PATH;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function seed(...ids) {
  for (const id of ids) {
    registerAgent({ id, name: id, kind: 'generic' });
  }
}

describe('resolveBaseAgent', () => {
  test('returns null for non-string / empty input', () => {
    expect(resolveBaseAgent(null)).toBeNull();
    expect(resolveBaseAgent(undefined)).toBeNull();
    expect(resolveBaseAgent('')).toBeNull();
    expect(resolveBaseAgent('   ')).toBeNull();
    expect(resolveBaseAgent(42)).toBeNull();
  });

  test('strict registered id resolves to itself', () => {
    seed('nova');
    expect(resolveBaseAgent('nova')).toBe('nova');
  });

  test('nova-3 resolves to registered base nova', () => {
    seed('nova');
    expect(resolveBaseAgent('nova-3')).toBe('nova');
  });

  test('hyphenated base my-agent is preserved when registered', () => {
    seed('my-agent');
    expect(resolveBaseAgent('my-agent')).toBe('my-agent');
    expect(resolveBaseAgent('my-agent-2')).toBe('my-agent');
    expect(resolveBaseAgent('my-agent-17')).toBe('my-agent');
  });

  test('my-other-agent does NOT collapse to my-agent', () => {
    // Both registered independently. A naive split('-')[0] would return
    // 'my' for both — this is the regression the resolver fix guards against.
    seed('my-agent', 'my-other-agent');
    expect(resolveBaseAgent('my-other-agent')).toBe('my-other-agent');
    expect(resolveBaseAgent('my-other-agent-4')).toBe('my-other-agent');
  });

  test('registry miss falls back to the trimmed id itself', () => {
    // Nothing registered — unknown ids stand alone.
    expect(resolveBaseAgent('ghost')).toBe('ghost');
    expect(resolveBaseAgent('ghost-2')).toBe('ghost-2');
    expect(resolveBaseAgent('  nova-2  ')).toBe('nova-2');
  });

  test('non-digit suffixes are not stripped', () => {
    // 'codex-worker' is a legit multi-segment base; the trailing '-worker'
    // is not a slot number and MUST be preserved even when codex-worker
    // isn't in the registry.
    expect(resolveBaseAgent('codex-worker')).toBe('codex-worker');
    seed('codex-worker');
    expect(resolveBaseAgent('codex-worker')).toBe('codex-worker');
    expect(resolveBaseAgent('codex-worker-2')).toBe('codex-worker');
  });

  test('strict match wins over peeling', () => {
    // If an operator registered a literal `nova-9` agent, that IS its
    // own base — we don't peel past a registered id.
    seed('nova', 'nova-9');
    expect(resolveBaseAgent('nova-9')).toBe('nova-9');
    expect(resolveBaseAgent('nova-9-2')).toBe('nova-9');
  });
});

describe('sameBaseAgent', () => {
  test('returns false on null / non-string input', () => {
    expect(sameBaseAgent(null, 'nova')).toBe(false);
    expect(sameBaseAgent('nova', null)).toBe(false);
    expect(sameBaseAgent(undefined, undefined)).toBe(false);
    expect(sameBaseAgent('', 'nova')).toBe(false);
    expect(sameBaseAgent(1, 2)).toBe(false);
  });

  test('identical strings short-circuit to true', () => {
    expect(sameBaseAgent('nova', 'nova')).toBe(true);
    expect(sameBaseAgent('ghost-7', 'ghost-7')).toBe(true); // even unregistered
  });

  test('compares case-insensitively', () => {
    expect(sameBaseAgent('Nova', 'nova')).toBe(true);
    expect(sameBaseAgent('ORION', 'orion')).toBe(true);
  });

  test('registeredBases injection supports client-side slot collapse', () => {
    const registeredBases = new Set(['nova', 'my-agent', 'orion']);
    expect(resolveBaseAgent('nova-2', registeredBases)).toBe('nova');
    expect(sameBaseAgent('nova-2', 'nova', registeredBases)).toBe(true);
    expect(sameBaseAgent('ghost-1', 'ghost-2', registeredBases)).toBe(false);
    expect(sameBaseAgent('my-agent-tool', 'my-agent', registeredBases)).toBe(false);
  });

  test('nova vs nova-3 same base', () => {
    seed('nova');
    expect(sameBaseAgent('nova', 'nova-3')).toBe(true);
    expect(sameBaseAgent('nova-2', 'nova-3')).toBe(true);
  });

  test('my-agent-2 shares base with my-agent but not my-other-agent', () => {
    // The critical regression case from the reviewer's rejection. Without
    // registry-backed resolve, a naive startsWith('my-' + '-') would
    // wrongly report my-other-agent as sharing base with my-agent.
    seed('my-agent', 'my-other-agent');
    expect(sameBaseAgent('my-agent', 'my-agent-2')).toBe(true);
    expect(sameBaseAgent('my-agent-2', 'my-agent-7')).toBe(true);
    expect(sameBaseAgent('my-agent', 'my-other-agent')).toBe(false);
    expect(sameBaseAgent('my-agent-2', 'my-other-agent-3')).toBe(false);
  });

  test('unregistered ids compare by strict string equality', () => {
    expect(sameBaseAgent('ghost-1', 'ghost-2')).toBe(false);
    expect(sameBaseAgent('ghost', 'ghost-2')).toBe(false);
  });

  test('hyphenated base codex-worker vs codex-worker-3 matches', () => {
    seed('codex-worker');
    expect(sameBaseAgent('codex-worker', 'codex-worker-3')).toBe(true);
    // But not codex-runner (different registered base).
    seed('codex-runner');
    expect(sameBaseAgent('codex-worker-2', 'codex-runner-2')).toBe(false);
  });
});
