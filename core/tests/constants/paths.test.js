/**
 * Coverage for core/constants/paths.js — every resolver, every precedence
 * branch. Env vars are saved and restored per test.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import path from 'node:path';
import {
  resolveStateRoot,
  resolveLogRoot,
  resolveCacheRoot,
  resolveProjectsRoot,
  resolveWorkspaceRoot,
  CORTEX_HOME,
} from '../../constants/paths.js';

const ENV_KEYS = [
  'CORTEX_HUB_DIR',
  'CORTEX_DATA_DIR',
  'CORTEX_PROJECTS_DIR',
  'CORTEX_HOME',
  'CORTEX_STATE_ROOT',
  'CORTEX_LOG_ROOT',
  'CORTEX_CACHE_ROOT',
];

let saved = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// ---------------------------------------------------------------------------
// resolveStateRoot
// ---------------------------------------------------------------------------

describe('resolveStateRoot', () => {
  test('should return explicit override when supplied', () => {
    expect(resolveStateRoot('/custom/state')).toBe('/custom/state');
  });

  test('should return CORTEX_STATE_ROOT when set and no override', () => {
    process.env.CORTEX_STATE_ROOT = '/env/state';
    expect(resolveStateRoot()).toBe('/env/state');
  });

  test('should return CORTEX_DATA_DIR/state when CORTEX_DATA_DIR is set', () => {
    process.env.CORTEX_DATA_DIR = '/env/data';
    expect(resolveStateRoot()).toBe('/env/data/state');
  });

  test('should fall back to CORTEX_HOME/state when no env is set', () => {
    expect(resolveStateRoot()).toBe(path.join(CORTEX_HOME, 'state'));
  });

  test('should prefer CORTEX_STATE_ROOT over CORTEX_DATA_DIR', () => {
    process.env.CORTEX_STATE_ROOT = '/s/state';
    process.env.CORTEX_DATA_DIR = '/s/data';
    expect(resolveStateRoot()).toBe('/s/state');
  });
});

// ---------------------------------------------------------------------------
// resolveLogRoot
// ---------------------------------------------------------------------------

describe('resolveLogRoot', () => {
  test('should return explicit override when supplied', () => {
    expect(resolveLogRoot('/logs/here')).toBe('/logs/here');
  });

  test('should return CORTEX_LOG_ROOT when set and no override', () => {
    process.env.CORTEX_LOG_ROOT = '/env/logs';
    expect(resolveLogRoot()).toBe('/env/logs');
  });

  test('should return CORTEX_DATA_DIR/logs when CORTEX_DATA_DIR is set', () => {
    process.env.CORTEX_DATA_DIR = '/env/data';
    expect(resolveLogRoot()).toBe('/env/data/logs');
  });

  test('should fall back to CORTEX_HOME/logs when no env is set', () => {
    expect(resolveLogRoot()).toBe(path.join(CORTEX_HOME, 'logs'));
  });

  test('should prefer CORTEX_LOG_ROOT over CORTEX_DATA_DIR', () => {
    process.env.CORTEX_LOG_ROOT = '/l/logs';
    process.env.CORTEX_DATA_DIR = '/l/data';
    expect(resolveLogRoot()).toBe('/l/logs');
  });
});

// ---------------------------------------------------------------------------
// resolveCacheRoot
// ---------------------------------------------------------------------------

describe('resolveCacheRoot', () => {
  test('should return explicit override when supplied', () => {
    expect(resolveCacheRoot('/cache/here')).toBe('/cache/here');
  });

  test('should return CORTEX_CACHE_ROOT when set and no override', () => {
    process.env.CORTEX_CACHE_ROOT = '/env/cache';
    expect(resolveCacheRoot()).toBe('/env/cache');
  });

  test('should return CORTEX_DATA_DIR/cache when CORTEX_DATA_DIR is set', () => {
    process.env.CORTEX_DATA_DIR = '/env/data';
    expect(resolveCacheRoot()).toBe('/env/data/cache');
  });

  test('should fall back to CORTEX_HOME/cache when no env is set', () => {
    expect(resolveCacheRoot()).toBe(path.join(CORTEX_HOME, 'cache'));
  });

  test('should prefer CORTEX_CACHE_ROOT over CORTEX_DATA_DIR', () => {
    process.env.CORTEX_CACHE_ROOT = '/c/cache';
    process.env.CORTEX_DATA_DIR = '/c/data';
    expect(resolveCacheRoot()).toBe('/c/cache');
  });
});

// ---------------------------------------------------------------------------
// resolveProjectsRoot + resolveWorkspaceRoot.
// Canonical = top-level <CORTEX_HOME>/projects. Launchers may pin the hub
// explicitly with CORTEX_HUB_DIR; CORTEX_DATA_DIR is runtime state and must not
// decide where project ledgers live.
// ---------------------------------------------------------------------------

describe('resolveProjectsRoot', () => {
  test('should prefer an explicit CORTEX_PROJECTS_DIR override', () => {
    process.env.CORTEX_PROJECTS_DIR = '/explicit/projects';
    process.env.CORTEX_DATA_DIR = '/data';
    expect(resolveProjectsRoot()).toBe('/explicit/projects');
  });

  test('should prefer CORTEX_HUB_DIR and ignore CORTEX_DATA_DIR', () => {
    process.env.CORTEX_HUB_DIR = '/hub';
    process.env.CORTEX_DATA_DIR = '/data';
    const got = resolveProjectsRoot();
    expect(got).toBe('/hub/projects');
    expect(got).not.toBe('/data/projects');
  });

  test('should honour a call-time CORTEX_HOME', () => {
    process.env.CORTEX_HOME = '/env/cortex';
    expect(resolveProjectsRoot()).toBe('/env/cortex/projects');
  });

  test('should fall back to the CORTEX_HOME const for <home>/projects when no env is set', () => {
    expect(resolveProjectsRoot()).toBe(path.join(CORTEX_HOME, 'projects'));
  });
});

describe('resolveWorkspaceRoot', () => {
  test('should return the same value as resolveProjectsRoot', () => {
    expect(resolveWorkspaceRoot()).toBe(resolveProjectsRoot());
  });
});
