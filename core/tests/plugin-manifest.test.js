/**
 * Plugin manifest schema smoke test. Must accept a well-formed manifest,
 * reject common typos (missing runtime, wrong api version shape, unknown
 * top-level field), and accept all defaulted optional sub-objects.
 */
import { describe, test, expect } from 'bun:test';
import { PluginManifestSchema } from '../schemas/plugin-manifest.js';

function baseManifest(overrides = {}) {
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
    subscribes: ['bridge.sent', 'session.opened'],
    requires_endpoints: ['/v1/api/bridge/inbox/:sessionId'],
    exposes: {
      health: 'http://127.0.0.1:0/health',
      endpoints: [
        { path: '/events', methods: ['POST'], auth: 'gateway' },
      ],
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
      startup_timeout_ms: 5000,
      shutdown_signal: 'SIGTERM',
      shutdown_timeout_ms: 3000,
    },
    ...overrides,
  };
}

describe('PluginManifestSchema', () => {
  test('accepts a full, realistic manifest', () => {
    const parsed = PluginManifestSchema.safeParse(baseManifest());
    expect(parsed.success).toBe(true);
  });

  test('rejects uppercase in name', () => {
    const parsed = PluginManifestSchema.safeParse(baseManifest({ name: 'CortexChannel' }));
    expect(parsed.success).toBe(false);
  });

  test('rejects unknown runtime', () => {
    const parsed = PluginManifestSchema.safeParse(baseManifest({ runtime: 'haskell' }));
    expect(parsed.success).toBe(false);
  });

  test('rejects non-semver version', () => {
    const parsed = PluginManifestSchema.safeParse(baseManifest({ version: 'v0.2' }));
    expect(parsed.success).toBe(false);
  });

  test('rejects unknown top-level field (strict)', () => {
    const parsed = PluginManifestSchema.safeParse(
      baseManifest({ extraField: 'nope' }),
    );
    expect(parsed.success).toBe(false);
  });

  test('rejects http_version that is not v<N>', () => {
    const parsed = PluginManifestSchema.safeParse(
      baseManifest({ api: { http_version: '1', mcp_tool_versions: {} } }),
    );
    expect(parsed.success).toBe(false);
  });

  test('rejects capability with bad shape', () => {
    const bad = baseManifest();
    bad.auth.capabilities = ['BadCap'];
    const parsed = PluginManifestSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
  });

  test('rejects subscribe subject without a dot', () => {
    const parsed = PluginManifestSchema.safeParse(
      baseManifest({ subscribes: ['bridgesent'] }),
    );
    expect(parsed.success).toBe(false);
  });

  test('rejects endpoint path without leading slash', () => {
    const bad = baseManifest();
    bad.exposes.endpoints = [{ path: 'events', methods: ['POST'], auth: 'gateway' }];
    const parsed = PluginManifestSchema.safeParse(bad);
    expect(parsed.success).toBe(false);
  });

  test('lifecycle defaults apply when omitted', () => {
    const minimal = baseManifest();
    minimal.lifecycle = { start: 'bun main.js' };
    const parsed = PluginManifestSchema.safeParse(minimal);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.lifecycle.restart_policy).toBe('on-failure');
      expect(parsed.data.lifecycle.max_restarts).toBe(5);
      expect(parsed.data.lifecycle.startup_timeout_ms).toBe(5000);
      expect(parsed.data.lifecycle.shutdown_signal).toBe('SIGTERM');
      expect(parsed.data.lifecycle.shutdown_timeout_ms).toBe(3000);
    }
  });

  test('accepts kind=bot, kind=service, kind=ui, kind=tool', () => {
    for (const kind of ['bot', 'service', 'adapter', 'ui', 'tool']) {
      expect(PluginManifestSchema.safeParse(baseManifest({ kind })).success).toBe(true);
    }
  });
});
