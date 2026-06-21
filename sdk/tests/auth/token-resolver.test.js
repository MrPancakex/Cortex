/**
 * Tests for sdk/auth/token-resolver.js
 *
 * Key design decisions documented here:
 * - "First matching line in file wins" — no key-name precedence between
 *   CORTEX_AGENT_TOKEN and CORTEX_BEARER; whichever appears first wins.
 *   CORTEX_REVIEWER_TOKEN is a reviewer-specific override and wins when present.
 *   This matches the bash reference (grep | head -1) and the JS regex
 *   with String.match (no g flag returns the first match).
 * - Total implicit-chain failure throws with an error message that
 *   references the last attempted path.
 */

import os from 'node:os';
import path from 'node:path';
import { describe, test, expect } from 'bun:test';
import { resolveAgentToken, CANONICAL_TOKEN_DIR } from '../../auth/token-resolver.js';

describe('CANONICAL_TOKEN_DIR genericization', () => {
  test('is homedir-derived, carries no hardcoded operator path', () => {
    expect(CANONICAL_TOKEN_DIR).not.toMatch(/\/home\/[a-z]/);
    expect(CANONICAL_TOKEN_DIR).toBe(path.join(os.homedir(), '.cortex', 'keys'));
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────

const VAULT_PATH = path.join(os.homedir(), '.cortex', 'keys', 'nova.env');
const LEGACY_PATH = '/etc/cortex/agents/nova.env';

function makeReader(map) {
  return (p) => {
    if (Object.prototype.hasOwnProperty.call(map, p)) return map[p];
    const err = new Error(`ENOENT: no such file: ${p}`);
    err.code = 'ENOENT';
    throw err;
  };
}

// ── 1. Explicit env value ──────────────────────────────────────────────────

describe('explicit env token', () => {
  test('returns trimmed CORTEX_AGENT_TOKEN immediately', () => {
    const token = resolveAgentToken({
      baseAgent: 'nova',
      env: { CORTEX_AGENT_TOKEN: '  tok-abc  ' },
    });
    expect(token).toBe('tok-abc');
  });

  test('env wins even when CORTEX_TOKEN_FILE is also set', () => {
    const token = resolveAgentToken({
      baseAgent: 'nova',
      env: { CORTEX_AGENT_TOKEN: 'env-tok', CORTEX_TOKEN_FILE: '/some/path' },
    });
    expect(token).toBe('env-tok');
  });

  test('returns trimmed CORTEX_BEARER when no CORTEX_AGENT_TOKEN is set', () => {
    const token = resolveAgentToken({
      baseAgent: 'nova',
      env: { CORTEX_BEARER: '  bearer-env  ' },
    });
    expect(token).toBe('bearer-env');
  });

  test('CORTEX_AGENT_TOKEN wins over CORTEX_BEARER when both are set', () => {
    const token = resolveAgentToken({
      baseAgent: 'nova',
      env: { CORTEX_AGENT_TOKEN: 'agent-env', CORTEX_BEARER: 'bearer-env' },
    });
    expect(token).toBe('agent-env');
  });

  test('does not call readFileFn when env token is present', () => {
    let called = false;
    resolveAgentToken({
      baseAgent: 'nova',
      env: { CORTEX_AGENT_TOKEN: 'x' },
      readFileFn: () => { called = true; return ''; },
    });
    expect(called).toBe(false);
  });
});

// ── 2. Explicit file (CORTEX_TOKEN_FILE) ──────────────────────────────────

describe('explicit file (CORTEX_TOKEN_FILE)', () => {
  test('reads token from explicit file — CORTEX_AGENT_TOKEN= key', () => {
    const token = resolveAgentToken({
      baseAgent: 'nova',
      env: { CORTEX_TOKEN_FILE: '/vault/nova.env' },
      readFileFn: makeReader({ '/vault/nova.env': 'CORTEX_AGENT_TOKEN=file-tok\n' }),
    });
    expect(token).toBe('file-tok');
  });

  test('reads token from explicit file — CORTEX_BEARER= key', () => {
    const token = resolveAgentToken({
      baseAgent: 'nova',
      env: { CORTEX_TOKEN_FILE: '/vault/nova.env' },
      readFileFn: makeReader({ '/vault/nova.env': 'CORTEX_BEARER=bearer-tok\n' }),
    });
    expect(token).toBe('bearer-tok');
  });

  test('reads reviewer token from explicit file and gives it key precedence', () => {
    const token = resolveAgentToken({
      baseAgent: 'orion',
      env: { CORTEX_TOKEN_FILE: '/vault/orion.env' },
      readFileFn: makeReader({
        '/vault/orion.env': 'CORTEX_AGENT_TOKEN=agent-tok\nCORTEX_REVIEWER_TOKEN=reviewer-tok\n',
      }),
    });
    expect(token).toBe('reviewer-tok');
  });

  test('throws when explicit file does not exist', () => {
    expect(() =>
      resolveAgentToken({
        baseAgent: 'nova',
        env: { CORTEX_TOKEN_FILE: '/missing/nova.env' },
        readFileFn: makeReader({}),
      }),
    ).toThrow(/ENOENT/);
  });

  test('throws when explicit file exists but key is absent', () => {
    expect(() =>
      resolveAgentToken({
        baseAgent: 'nova',
        env: { CORTEX_TOKEN_FILE: '/vault/nova.env' },
        readFileFn: makeReader({ '/vault/nova.env': 'IRRELEVANT=x\n' }),
      }),
    ).toThrow(/not found/);
  });

  test('calls swallowFn on explicit file failure', () => {
    const calls = [];
    expect(() =>
      resolveAgentToken({
        baseAgent: 'nova',
        env: { CORTEX_TOKEN_FILE: '/vault/nova.env' },
        readFileFn: makeReader({}),
        swallowFn: (metric, err) => calls.push({ metric, err }),
      }),
    ).toThrow();
    expect(calls).toHaveLength(1);
  });

  test('CORTEX_AGENT_TOKEN_FILE aliases the explicit file branch', () => {
    const token = resolveAgentToken({
      baseAgent: 'nova',
      env: { CORTEX_AGENT_TOKEN_FILE: '/vault/nova.env' },
      readFileFn: makeReader({ '/vault/nova.env': 'CORTEX_BEARER=agent-file-tok\n' }),
    });
    expect(token).toBe('agent-file-tok');
  });
});

// ── 3. Implicit chain — canonical before legacy ────────────────────────────

describe('implicit chain order', () => {
  test('tries canonical vault path before legacy /etc path', () => {
    const tried = [];
    const reader = (p) => {
      tried.push(p);
      const err = new Error(`ENOENT: ${p}`);
      err.code = 'ENOENT';
      throw err;
    };
    expect(() =>
      resolveAgentToken({ baseAgent: 'nova', env: {}, readFileFn: reader }),
    ).toThrow();
    expect(tried[0]).toBe(VAULT_PATH);
    expect(tried[1]).toBe(LEGACY_PATH);
  });

  test('returns token from canonical vault when it exists', () => {
    const token = resolveAgentToken({
      baseAgent: 'nova',
      env: {},
      readFileFn: makeReader({ [VAULT_PATH]: 'CORTEX_BEARER=vault-tok\n' }),
    });
    expect(token).toBe('vault-tok');
  });

  test('falls through to legacy path when vault is missing', () => {
    const token = resolveAgentToken({
      baseAgent: 'nova',
      env: {},
      readFileFn: makeReader({ [LEGACY_PATH]: 'CORTEX_AGENT_TOKEN=legacy-tok\n' }),
    });
    expect(token).toBe('legacy-tok');
  });

  test('CORTEX_TOKEN_DIR override is tried before canonical vault', () => {
    const tried = [];
    const reader = (p) => {
      tried.push(p);
      const map = {
        '/override/nova.env': 'CORTEX_BEARER=override-tok\n',
        [VAULT_PATH]: 'CORTEX_BEARER=vault-tok\n',
      };
      if (Object.prototype.hasOwnProperty.call(map, p)) return map[p];
      const err = new Error(`ENOENT: ${p}`);
      err.code = 'ENOENT';
      throw err;
    };
    const token = resolveAgentToken({
      baseAgent: 'nova',
      env: { CORTEX_TOKEN_DIR: '/override' },
      readFileFn: reader,
    });
    expect(token).toBe('override-tok');
    expect(tried[0]).toBe('/override/nova.env');
  });
});

// ── 4. Both key names accepted ─────────────────────────────────────────────

describe('key name acceptance', () => {
  test('CORTEX_AGENT_TOKEN= is accepted in implicit chain', () => {
    const token = resolveAgentToken({
      baseAgent: 'nova',
      env: {},
      readFileFn: makeReader({ [VAULT_PATH]: 'CORTEX_AGENT_TOKEN=tok1\n' }),
    });
    expect(token).toBe('tok1');
  });

  test('CORTEX_BEARER= is accepted in implicit chain', () => {
    const token = resolveAgentToken({
      baseAgent: 'nova',
      env: {},
      readFileFn: makeReader({ [VAULT_PATH]: 'CORTEX_BEARER=tok2\n' }),
    });
    expect(token).toBe('tok2');
  });

  test('commented-out token is not matched (line must start at col 0)', () => {
    expect(() =>
      resolveAgentToken({
        baseAgent: 'nova',
        env: {},
        readFileFn: makeReader({ [VAULT_PATH]: '# CORTEX_BEARER=commented\n' }),
      }),
    ).toThrow();
  });

  test('first occurrence wins when both keys appear in the same file', () => {
    // Contract: first matching line, no key-name precedence.
    const content = 'CORTEX_AGENT_TOKEN=first\nCORTEX_BEARER=second\n';
    const token = resolveAgentToken({
      baseAgent: 'nova',
      env: {},
      readFileFn: makeReader({ [VAULT_PATH]: content }),
    });
    expect(token).toBe('first');
  });

  test('trims whitespace from parsed token value', () => {
    const token = resolveAgentToken({
      baseAgent: 'nova',
      env: {},
      readFileFn: makeReader({ [VAULT_PATH]: 'CORTEX_BEARER=  padded  \n' }),
    });
    expect(token).toBe('padded');
  });
});

// ── 5. Total failure ───────────────────────────────────────────────────────

describe('total failure', () => {
  test('throws when all implicit candidates fail', () => {
    expect(() =>
      resolveAgentToken({ baseAgent: 'nova', env: {}, readFileFn: makeReader({}) }),
    ).toThrow();
  });

  test('thrown error message references the last attempted path', () => {
    let thrown;
    try {
      resolveAgentToken({ baseAgent: 'nova', env: {}, readFileFn: makeReader({}) });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    expect(thrown.message).toContain(LEGACY_PATH);
  });

  test('calls swallowFn for each swallowed candidate failure', () => {
    const calls = [];
    expect(() =>
      resolveAgentToken({
        baseAgent: 'nova',
        env: {},
        readFileFn: makeReader({}),
        swallowFn: (metric, err) => calls.push({ metric, err }),
      }),
    ).toThrow();
    // Two candidates + one final swallow = 3 calls
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});

// ── 6. Candidates override ─────────────────────────────────────────────────

describe('candidates override', () => {
  test('uses injected candidates list instead of default paths', () => {
    const tried = [];
    const reader = (p) => {
      tried.push(p);
      const err = new Error(`ENOENT: ${p}`);
      err.code = 'ENOENT';
      throw err;
    };
    const custom = ['/custom/a.env', '/custom/b.env'];
    expect(() =>
      resolveAgentToken({
        baseAgent: 'nova',
        env: {},
        candidates: custom,
        readFileFn: reader,
      }),
    ).toThrow();
    expect(tried).toEqual(custom);
  });
});

// ── 6b. Exact-id-first, then peeled-base, vault filenames ──────────────────

const EXACT_VAULT_2 = path.join(os.homedir(), '.cortex', 'keys', 'nova-2.env');
const EXACT_LEGACY_2 = '/etc/cortex/agents/nova-2.env';

describe('session-slot base-keying', () => {
  test('session-slot nova-2 (no nova-2.env) falls through to the base nova.env', () => {
    // Only the BASE keyfile exists → a session slot shares it.
    const token = resolveAgentToken({
      baseAgent: 'nova-2',
      env: {},
      readFileFn: makeReader({ [VAULT_PATH]: 'CORTEX_BEARER=base-tok\n' }),
    });
    expect(token).toBe('base-tok');
  });

  test('STANDALONE nova-2 resolves its EXACT nova-2.env — does NOT fall back to base', () => {
    // Regression for Task-95 #4: a standalone registered numeric-suffix agent
    // with its OWN nova-2.env must authenticate via the exact keyfile. The
    // original review probe failed because resolution peeled nova-2 → nova
    // and skipped nova-2.env entirely. Both keyfiles exist here with DIFFERENT
    // tokens; the exact one must win.
    const tried = [];
    const reader = (p) => {
      tried.push(p);
      const map = {
        [EXACT_VAULT_2]: 'CORTEX_BEARER=standalone-tok\n',
        [VAULT_PATH]: 'CORTEX_BEARER=base-tok\n',
      };
      if (Object.prototype.hasOwnProperty.call(map, p)) return map[p];
      const err = new Error(`ENOENT: ${p}`);
      err.code = 'ENOENT';
      throw err;
    };
    const token = resolveAgentToken({ baseAgent: 'nova-2', env: {}, readFileFn: reader });
    expect(token).toBe('standalone-tok');
    // Exact candidate must be probed FIRST — and since it resolves, the peeled
    // base nova.env is never reached (short-circuit on first hit).
    expect(tried[0]).toBe(EXACT_VAULT_2);
    expect(tried).not.toContain(VAULT_PATH);
  });

  test('nova-7 probe order is [exact-canonical, base-canonical, exact-legacy, base-legacy]', () => {
    const tried = [];
    const reader = (p) => {
      tried.push(p);
      const err = new Error(`ENOENT: ${p}`);
      err.code = 'ENOENT';
      throw err;
    };
    expect(() =>
      resolveAgentToken({ baseAgent: 'nova-7', env: {}, readFileFn: reader }),
    ).toThrow();
    // Exact-id-first within each dir tier; canonical dir before legacy dir.
    expect(tried).toEqual([
      path.join(os.homedir(), '.cortex', 'keys', 'nova-7.env'),
      VAULT_PATH,
      '/etc/cortex/agents/nova-7.env',
      LEGACY_PATH,
    ]);
  });

  test('hyphenated base peels only the digit tail (codex-worker-3 → codex-worker)', () => {
    const token = resolveAgentToken({
      baseAgent: 'codex-worker-3',
      env: {},
      readFileFn: makeReader({
        [path.join(os.homedir(), '.cortex', 'keys', 'codex-worker.env')]: 'CORTEX_BEARER=cw-tok\n',
      }),
    });
    expect(token).toBe('cw-tok');
  });

  test('non-digit hyphen suffix is NOT peeled (nova-v2 stays nova-v2)', () => {
    const token = resolveAgentToken({
      baseAgent: 'nova-v2',
      env: {},
      readFileFn: makeReader({
        [path.join(os.homedir(), '.cortex', 'keys', 'nova-v2.env')]: 'CORTEX_BEARER=v2-tok\n',
      }),
    });
    expect(token).toBe('v2-tok');
  });

  test('explicit candidates override bypasses the peel (caller owns paths)', () => {
    const tried = [];
    const reader = (p) => {
      tried.push(p);
      const err = new Error(`ENOENT: ${p}`);
      err.code = 'ENOENT';
      throw err;
    };
    const custom = ['/custom/nova-2.env'];
    expect(() =>
      resolveAgentToken({ baseAgent: 'nova-2', env: {}, candidates: custom, readFileFn: reader }),
    ).toThrow();
    expect(tried).toEqual(custom);
  });
});

// ── 7. Validation ──────────────────────────────────────────────────────────

describe('validation', () => {
  test('throws when baseAgent is missing', () => {
    expect(() => resolveAgentToken({ baseAgent: '' })).toThrow(/baseAgent/);
  });

  test('throws when baseAgent is undefined', () => {
    expect(() => resolveAgentToken({})).toThrow(/baseAgent/);
  });
});
