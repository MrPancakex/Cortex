/**
 * Tests for sdk/auth/token-registry-file.js — the path-resolution and
 * load logic that decides which on-disk file is the authoritative
 * source of bot identity.
 *
 * Locks in the single-source-of-truth contract that bin/cortex-init.js
 * and scripts/run-prod.sh both depend on: every reader/writer must
 * compute the registry path the same way. A drift here is exactly the
 * v0.1→v0.2 cutover bug this test exists to prevent (init wrote to
 * $DATA_DIR/token-registry.json, gateway loaded from
 * $DATA_DIR/state/token-registry.json, every bot resolved to anon).
 */

import { test, describe, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  resolveTokenRegistryPath,
  loadTokenRegistryFile,
} from '../../auth/token-registry-file.js';

let tempRoot;
const origEnv = {};

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-registry-test-'));
  origEnv.CORTEX_TOKEN_REGISTRY = process.env.CORTEX_TOKEN_REGISTRY;
  origEnv.CORTEX_STATE_ROOT     = process.env.CORTEX_STATE_ROOT;
  origEnv.CORTEX_DATA_DIR       = process.env.CORTEX_DATA_DIR;
  delete process.env.CORTEX_TOKEN_REGISTRY;
  delete process.env.CORTEX_STATE_ROOT;
  delete process.env.CORTEX_DATA_DIR;
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  for (const [k, v] of Object.entries(origEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('resolveTokenRegistryPath', () => {
  test('explicit override wins over env and defaults', () => {
    process.env.CORTEX_TOKEN_REGISTRY = '/should/be/ignored.json';
    expect(resolveTokenRegistryPath('/explicit/path.json')).toBe('/explicit/path.json');
  });

  test('CORTEX_TOKEN_REGISTRY env wins over state-root default', () => {
    process.env.CORTEX_TOKEN_REGISTRY = path.join(tempRoot, 'custom.json');
    expect(resolveTokenRegistryPath()).toBe(path.join(tempRoot, 'custom.json'));
  });

  test('falls back to <state-root>/token-registry.json when no override', () => {
    process.env.CORTEX_STATE_ROOT = tempRoot;
    expect(resolveTokenRegistryPath()).toBe(path.join(tempRoot, 'token-registry.json'));
  });

  test('uses $CORTEX_DATA_DIR/state when CORTEX_STATE_ROOT unset', () => {
    process.env.CORTEX_DATA_DIR = tempRoot;
    expect(resolveTokenRegistryPath()).toBe(path.join(tempRoot, 'state', 'token-registry.json'));
  });
});

describe('loadTokenRegistryFile', () => {
  test('returns {agents: {}} when file missing', () => {
    expect(loadTokenRegistryFile({ path: path.join(tempRoot, 'missing.json') }))
      .toEqual({ agents: {} });
  });

  test('parses a valid registry', () => {
    const file = path.join(tempRoot, 'registry.json');
    fs.writeFileSync(file, JSON.stringify({
      agents: {
        nova: { hash: 'a'.repeat(64), role: 'agent', base: 'nova' },
        root: { hash: 'b'.repeat(64), role: 'admin', base: 'root' },
      },
    }));
    const reg = loadTokenRegistryFile({ path: file });
    expect(Object.keys(reg.agents).sort()).toEqual(['nova', 'root']);
    expect(reg.agents.nova.role).toBe('agent');
    expect(reg.agents.root.role).toBe('admin');
  });

  test('throws on invalid JSON', () => {
    const file = path.join(tempRoot, 'broken.json');
    fs.writeFileSync(file, '{ not valid json');
    expect(() => loadTokenRegistryFile({ path: file })).toThrow('not valid JSON');
  });

  test('throws when "agents" key is missing', () => {
    const file = path.join(tempRoot, 'no-agents.json');
    fs.writeFileSync(file, JSON.stringify({ random: 'object' }));
    expect(() => loadTokenRegistryFile({ path: file })).toThrow('missing "agents"');
  });

  test('rejects duplicate-hash agents (catastrophic identity collision)', () => {
    const sharedHash = 'c'.repeat(64);
    const file = path.join(tempRoot, 'dup.json');
    fs.writeFileSync(file, JSON.stringify({
      agents: {
        nova:  { hash: sharedHash, role: 'agent' },
        orion: { hash: sharedHash, role: 'agent' },
      },
    }));
    expect(() => loadTokenRegistryFile({ path: file })).toThrow();
  });

  // Cutover-bug regression: when bin/cortex-init.js wrote the registry
  // to $DATA_DIR/token-registry.json but the gateway loaded from
  // $DATA_DIR/state/token-registry.json (no `state/` segment in init),
  // the gateway saw an empty registry and every bot token resolved to
  // anon. This test pins the contract: a writer and a reader using the
  // same resolveTokenRegistryPath() must agree on which file to use.
  test('writer/reader path agreement under env-set CORTEX_DATA_DIR', () => {
    process.env.CORTEX_DATA_DIR = tempRoot;
    const writerPath = resolveTokenRegistryPath();
    fs.mkdirSync(path.dirname(writerPath), { recursive: true });
    fs.writeFileSync(writerPath, JSON.stringify({
      agents: { nova: { hash: 'd'.repeat(64), role: 'agent', base: 'nova' } },
    }));
    const readerPath = resolveTokenRegistryPath();
    expect(readerPath).toBe(writerPath);
    const reg = loadTokenRegistryFile();
    expect(reg.agents.nova.hash).toBe('d'.repeat(64));
  });

  // B1 regression (pass-1 review): if a writer (e.g. bin/cortex-init.js)
  // calls resolveTokenRegistryPath() with NO Cortex env exported, the
  // resolver falls through to $CORTEX_HOME/state/token-registry.json
  // (repo-root/state — no `data/` segment), which disagrees with
  // run-prod.sh's $CORTEX_DATA_DIR/state. A writer that wants the
  // data-dir branch MUST export CORTEX_DATA_DIR (or CORTEX_STATE_ROOT
  // or CORTEX_TOKEN_REGISTRY) before calling the resolver.
  test('resolver with no env set falls back to CORTEX_HOME (not $HOME/Cortex/data/state)', () => {
    // Confirms the precedence so callers know to set CORTEX_DATA_DIR
    // explicitly when they need the data-dir branch.
    const result = resolveTokenRegistryPath();
    expect(result).not.toContain('/data/state/');
    expect(result.endsWith('/state/token-registry.json')).toBe(true);
  });
});
