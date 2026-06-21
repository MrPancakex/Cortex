/**
 * Constants smoke test — verifies the documented extraction contract every
 * later phase imports: ports, status enums, PRIORITY_RANK, model cost table,
 * provider routing, credential map, process supervisor defaults, paths,
 * session tunables, logging rotation escalation.
 */
import { describe, test, expect } from 'bun:test';
import path from 'node:path';
import {
  GATEWAY_PORT,
  PLATFORM_PORT,
  MCP_PORT,
  TASK_STATUSES,
  SESSION_STATUSES,
  AGENT_STATUSES,
  PRIORITY_RANK,
  MODEL_COST_TABLE,
  MAX_BODY_BYTES,
  MAX_WS_PER_AGENT,
  MAX_REJECTIONS,
  POISON_SWEEP_MS,
  LEASE_SUFFIX,
  CORTEX_HOME,
  WORKSPACE_ROOT,
  DATA_DIR,
  PROVIDER_ROUTES,
  OLLAMA_HOST,
  CREDS_DIR,
  CREDENTIAL_MAP,
  ProcessState,
  ROTATION_ESCALATE_AFTER,
} from '../index.js';

import {
  priorityRank,
  isTerminalTaskStatus,
  isActiveTaskStatus,
  resolveModel,
  costFor,
  getProvider,
  resolveProjectsRoot,
  resolveWorkspaceRoot,
} from '../constants/index.js';
import { DEFAULTS as PROCESS_DEFAULTS } from '../constants/process.js';

describe('ports', () => {
  test('default gateway port is 4840', () => {
    expect(GATEWAY_PORT).toBe(4840);
  });
  test('default platform port is 4841', () => {
    expect(PLATFORM_PORT).toBe(4841);
  });
  test('default MCP port is 4842', () => {
    expect(MCP_PORT).toBe(4842);
  });
});

describe('status enums (derived from zod schemas)', () => {
  test('TASK_STATUSES includes the Phase-5 orphaned state', () => {
    expect(TASK_STATUSES).toEqual([
      'pending',
      'claimed',
      'in_progress',
      'submitted',
      'review',
      'approved',
      'rejected',
      'cancelled',
      'failed',
      'orphaned',
    ]);
    expect(TASK_STATUSES.includes('orphaned')).toBe(true);
  });
  test('SESSION_STATUSES includes poisoned', () => {
    expect(SESSION_STATUSES).toContain('poisoned');
  });
  test('AGENT_STATUSES is UPPERCASE triple (matches legacy)', () => {
    expect(AGENT_STATUSES).toEqual(['ACTIVE', 'IDLE', 'OFFLINE']);
  });
  test('isTerminalTaskStatus / isActiveTaskStatus are consistent', () => {
    expect(isTerminalTaskStatus('approved')).toBe(true);
    expect(isTerminalTaskStatus('cancelled')).toBe(true);
    expect(isTerminalTaskStatus('failed')).toBe(true);
    expect(isTerminalTaskStatus('pending')).toBe(false);
    expect(isActiveTaskStatus('submitted')).toBe(true);
    expect(isActiveTaskStatus('review')).toBe(true);
  });
});

describe('PRIORITY_RANK (lifted from cortex-tasks.js:119-127)', () => {
  test('orders critical > high > medium > low', () => {
    expect(PRIORITY_RANK.critical).toBe(4);
    expect(PRIORITY_RANK.high).toBe(3);
    expect(PRIORITY_RANK.medium).toBe(2);
    expect(PRIORITY_RANK.normal).toBe(2);
    expect(PRIORITY_RANK.low).toBe(1);
  });
  test('priorityRank falls back to 0 for unknown', () => {
    expect(priorityRank('bogus')).toBe(0);
    expect(priorityRank('critical')).toBe(4);
  });
  test('PRIORITY_RANK is frozen', () => {
    expect(Object.isFrozen(PRIORITY_RANK)).toBe(true);
  });
});

describe('MODEL_COST_TABLE', () => {
  test('is frozen and has Anthropic/OpenAI/Google/local keys', () => {
    expect(Object.isFrozen(MODEL_COST_TABLE)).toBe(true);
    expect(MODEL_COST_TABLE['claude-opus-4-7']).toBeTruthy();
    expect(MODEL_COST_TABLE['gpt-5']).toBeTruthy();
    expect(MODEL_COST_TABLE['local']).toBeTruthy();
  });
  test('resolveModel normalises aliases', () => {
    expect(resolveModel('claude-opus')).toBe('claude-opus-4-8');
    expect(resolveModel('GPT5')).toBe('gpt-5');
    expect(resolveModel(null)).toBe(null);
  });
  test('costFor returns null for unknown models', () => {
    expect(costFor('made-up-model')).toBeNull();
    expect(costFor('claude-opus').input).toBeGreaterThan(0);
  });
  test('C0: costFor is non-null for the 4 current-generation model ids', () => {
    // These were unpriced before C0; calcCostUsd returned null for them,
    // silently zeroing cost rows. All four must now resolve to a priced entry.
    expect(costFor('claude-opus-4-8')).not.toBeNull();
    expect(costFor('claude-sonnet-4-6')).not.toBeNull();
    expect(costFor('claude-haiku-4-5')).not.toBeNull();
    expect(costFor('claude-fable-5')).not.toBeNull();
    // Rates sanity-check (non-zero input/output)
    expect(costFor('claude-opus-4-8').input).toBeGreaterThan(0);
    expect(costFor('claude-sonnet-4-6').output).toBeGreaterThan(0);
    expect(costFor('claude-haiku-4-5').cache_read).toBeGreaterThan(0);
    // Alias resolution via resolveModel
    expect(costFor('claude-opus')).not.toBeNull();
    expect(costFor('claude-sonnet')).not.toBeNull();
    expect(costFor('claude-haiku')).not.toBeNull();
    expect(costFor('claude-haiku-4-5-20251001')).not.toBeNull();
  });
});

describe('payload caps', () => {
  test('MAX_BODY_BYTES = 2 MiB', () => {
    expect(MAX_BODY_BYTES).toBe(2 * 1024 * 1024);
  });
  test('MAX_WS_PER_AGENT = 4', () => {
    expect(MAX_WS_PER_AGENT).toBe(4);
  });
  test('MAX_REJECTIONS = 6', () => {
    expect(MAX_REJECTIONS).toBe(6);
  });
});

describe('session tunables', () => {
  test('POISON_SWEEP_MS = 30s', () => {
    expect(POISON_SWEEP_MS).toBe(30_000);
  });
  test('LEASE_SUFFIX = .lease', () => {
    expect(LEASE_SUFFIX).toBe('.lease');
  });
});

describe('paths (lifted from lib/task-files.js:7-18)', () => {
  test('exposes CORTEX_HOME, WORKSPACE_ROOT, DATA_DIR', () => {
    expect(typeof CORTEX_HOME).toBe('string');
    expect(CORTEX_HOME.length).toBeGreaterThan(0);
    expect(typeof WORKSPACE_ROOT).toBe('string');
    expect(typeof DATA_DIR).toBe('string');
  });
  test('resolveProjectsRoot uses $CORTEX_HUB_DIR and ignores $CORTEX_DATA_DIR', () => {
    const prev = {
      hub: process.env.CORTEX_HUB_DIR,
      data: process.env.CORTEX_DATA_DIR,
    };
    try {
      // The projects tree is top-level <hub>/projects. CORTEX_DATA_DIR is
      // runtime state and must not decide where ledgers live.
      process.env.CORTEX_HUB_DIR = '/tmp/hub-1';
      process.env.CORTEX_DATA_DIR = '/tmp/data-1';
      const got = resolveProjectsRoot();
      expect(got).toBe('/tmp/hub-1/projects');
      expect(got).not.toBe('/tmp/data-1/projects');
    } finally {
      if (prev.hub === undefined) delete process.env.CORTEX_HUB_DIR;
      else process.env.CORTEX_HUB_DIR = prev.hub;
      if (prev.data === undefined) delete process.env.CORTEX_DATA_DIR;
      else process.env.CORTEX_DATA_DIR = prev.data;
    }
  });
  test('resolveWorkspaceRoot is an alias for resolveProjectsRoot', () => {
    expect(resolveWorkspaceRoot()).toBe(resolveProjectsRoot());
  });
});

describe('providers (lifted from lib/proxy.js:33-45)', () => {
  test('PROVIDER_ROUTES is frozen and has all legacy routes', () => {
    expect(Object.isFrozen(PROVIDER_ROUTES)).toBe(true);
    const prefixes = PROVIDER_ROUTES.map((r) => r.prefix);
    expect(prefixes).toContain('/v1/messages');
    expect(prefixes).toContain('/v1/chat/completions');
    expect(prefixes).toContain('/api/chat');
    expect(prefixes).toContain('/openrouter/v1/');
  });
  test('OLLAMA_HOST defaults to 127.0.0.1:11434', () => {
    // Only true when the env var isn't set at test time; the runner should
    // start with a clean env, but guard the assertion either way.
    if (!process.env.OLLAMA_HOST) {
      expect(OLLAMA_HOST).toBe('http://127.0.0.1:11434');
    } else {
      expect(OLLAMA_HOST).toBe(process.env.OLLAMA_HOST);
    }
  });
  test('getProvider returns metadata for known provider', () => {
    const a = getProvider('anthropic');
    expect(a).not.toBeNull();
    expect(a.env).toContain('ANTHROPIC_API_KEY');
    expect(getProvider('made-up')).toBeNull();
  });
});

describe('credentials (lifted from lib/credentials.js:12-18)', () => {
  test('CREDS_DIR mirrors $CREDENTIALS_DIRECTORY', () => {
    expect(CREDS_DIR === null || typeof CREDS_DIR === 'string').toBe(true);
  });
  test('CREDENTIAL_MAP contains the three provider keys', () => {
    expect(Object.isFrozen(CREDENTIAL_MAP)).toBe(true);
    expect(CREDENTIAL_MAP['openai-key']).toBe('OPENAI_API_KEY');
    expect(CREDENTIAL_MAP['anthropic-key']).toBe('ANTHROPIC_API_KEY');
    expect(CREDENTIAL_MAP['openrouter-key']).toBe('OPENROUTER_API_KEY');
  });
});

describe('process (lifted from lib/process-supervisor.js:55-75)', () => {
  test('ProcessState has every lifecycle value', () => {
    expect(ProcessState.LAUNCHING).toBe('launching');
    expect(ProcessState.ONLINE).toBe('online');
    expect(ProcessState.STOPPING).toBe('stopping');
    expect(ProcessState.STOPPED).toBe('stopped');
    expect(ProcessState.WAITING_RESTART).toBe('waiting_restart');
    expect(ProcessState.ERRORED).toBe('errored');
    expect(ProcessState.UNHEALTHY).toBe('unhealthy');
  });
  test('ProcessState is frozen', () => {
    expect(Object.isFrozen(ProcessState)).toBe(true);
  });
  test('DEFAULTS carries the documented supervisor knobs', () => {
    expect(PROCESS_DEFAULTS.maxRestarts).toBe(16);
    expect(PROCESS_DEFAULTS.minUptime).toBe(1000);
    expect(PROCESS_DEFAULTS.initialBackoffMs).toBe(500);
    expect(PROCESS_DEFAULTS.backoffFactor).toBe(1.5);
    expect(PROCESS_DEFAULTS.maxBackoffMs).toBe(15_000);
    expect(PROCESS_DEFAULTS.killTimeoutMs).toBe(8_000);
    expect(PROCESS_DEFAULTS.readyTimeoutMs).toBe(30_000);
    expect(PROCESS_DEFAULTS.waitReady).toBe(false);
    expect(PROCESS_DEFAULTS.stopExitCodes).toEqual([0]);
  });
});

describe('logging rotation', () => {
  test('ROTATION_ESCALATE_AFTER = 3 (matches lib/log-manager.js:17)', () => {
    expect(ROTATION_ESCALATE_AFTER).toBe(3);
  });
});
