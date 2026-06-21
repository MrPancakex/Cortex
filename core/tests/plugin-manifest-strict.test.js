/**
 * Phase-11 additions to core/schemas/plugin-manifest.js — Strict /
 * Signed / TrustKey / TrustStore schemas + conformance tests for every
 * shipped plugin manifest.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  StrictPluginManifestSchema,
  SignedPluginManifestSchema,
  PluginTrustKeySchema,
  PluginTrustStoreSchema,
} from '../schemas/plugin-manifest.js';

function baseStrict(overrides = {}) {
  return {
    name: 'cortex-channel',
    version: '0.2.0',
    kind: 'adapter',
    runtime: 'bun',
    entry: 'main.js',
    api: {
      http_version: 'v1',
      mcp_tool_versions: { bridge_inbox: '1.0.0' },
    },
    subscribes: ['bridge.sent'],
    requires_endpoints: ['/v1/api/bridge/inbox/:sessionId'],
    exposes: {
      health: 'http://127.0.0.1:0/health',
      endpoints: [{ path: '/events', methods: ['POST'], auth: 'gateway' }],
      mcp_tools: [],
      publishes: [],
    },
    auth: {
      token_file: 'CORTEX_AGENT_TOKEN',
      identity: 'nova',
      capabilities: ['bridge.read', 'bridge.ack'],
    },
    lifecycle: {
      start: 'bun main.js',
      restart_policy: 'on-failure',
      max_restarts: 5,
    },
    ...overrides,
  };
}

describe('StrictPluginManifestSchema', () => {
  test('accepts a well-formed manifest', () => {
    const parsed = StrictPluginManifestSchema.safeParse(baseStrict());
    expect(parsed.success).toBe(true);
  });

  test('rejects unknown top-level fields', () => {
    const parsed = StrictPluginManifestSchema.safeParse(
      baseStrict({ extraneous: 'no' }),
    );
    expect(parsed.success).toBe(false);
  });

  test('rejects capability with bad shape', () => {
    const bad = baseStrict();
    bad.auth.capabilities = ['NotLower.With'];
    const parsed = StrictPluginManifestSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
  });

  test('defaults restart_policy when omitted', () => {
    const minimal = baseStrict();
    minimal.lifecycle = { start: 'bun main.js' };
    const parsed = StrictPluginManifestSchema.safeParse(minimal);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.lifecycle.restart_policy).toBe('on-failure');
      expect(parsed.data.lifecycle.max_restarts).toBe(5);
    }
  });

  test('accepts kind=reviewer and kind=tool and kind=runner (phase-11 set)', () => {
    for (const kind of ['adapter', 'reviewer', 'tool', 'runner', 'bot', 'service']) {
      expect(
        StrictPluginManifestSchema.safeParse(baseStrict({ kind })).success,
      ).toBe(true);
    }
  });

  test('rejects http_version that is not v<N>', () => {
    const parsed = StrictPluginManifestSchema.safeParse(
      baseStrict({ api: { http_version: 'one', mcp_tool_versions: {} } }),
    );
    expect(parsed.success).toBe(false);
  });
});

describe('SignedPluginManifestSchema', () => {
  function baseSigned(overrides = {}) {
    return {
      ...baseStrict({ auth: { ...baseStrict().auth, signed: true } }),
      signature: {
        key_id: 'k1',
        algorithm: 'RSA-SHA256',
        value: 'YmFzZTY0',
      },
      ...overrides,
    };
  }

  test('accepts a signed manifest', () => {
    const parsed = SignedPluginManifestSchema.safeParse(baseSigned());
    expect(parsed.success).toBe(true);
  });

  test('rejects when signature block is missing', () => {
    const m = baseSigned();
    delete m.signature;
    const parsed = SignedPluginManifestSchema.safeParse(m);
    expect(parsed.success).toBe(false);
  });

  test('rejects non-RSA-SHA256 algorithm', () => {
    const parsed = SignedPluginManifestSchema.safeParse(
      baseSigned({
        signature: { key_id: 'k1', algorithm: 'HS256', value: 'x' },
      }),
    );
    expect(parsed.success).toBe(false);
  });
});

describe('PluginTrustKey + PluginTrustStore', () => {
  test('trust key accepts RSA-SHA256 entry', () => {
    const parsed = PluginTrustKeySchema.safeParse({
      key_id: 'k1',
      algorithm: 'RSA-SHA256',
      public_key_pem: '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----',
    });
    expect(parsed.success).toBe(true);
  });

  test('trust store defaults keys to empty array', () => {
    const parsed = PluginTrustStoreSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.keys).toEqual([]);
  });

  test('trust store rejects unknown top-level fields', () => {
    const parsed = PluginTrustStoreSchema.safeParse({ keys: [], wat: true });
    expect(parsed.success).toBe(false);
  });
});

describe('conformance: every plugins/*/plugin.manifest.json parses as Strict', () => {
  const pluginsRoot = join(import.meta.dir, '..', '..', 'plugins');
  if (!existsSync(pluginsRoot)) {
    test('no plugins/ directory present (skipped)', () => {
      expect(true).toBe(true);
    });
    return;
  }
  for (const entry of readdirSync(pluginsRoot)) {
    const dir = join(pluginsRoot, entry);
    if (!statSync(dir).isDirectory()) continue;
    const manifestPath = join(dir, 'plugin.manifest.json');
    if (!existsSync(manifestPath)) continue;
    test(`plugins/${entry}/plugin.manifest.json — Strict parse`, () => {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const parsed = StrictPluginManifestSchema.safeParse(raw);
      if (!parsed.success) {
        // Surface first issue for easy debugging.
        const issue = parsed.error.issues[0];
        throw new Error(
          `manifest invalid: ${issue.path.join('.')} — ${issue.message}`,
        );
      }
      expect(parsed.success).toBe(true);
    });
  }
});
