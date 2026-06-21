import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../backend/lib/config.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-config-'));

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] == null) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

describe('loadConfig', () => {
  const paths = {
    missing: path.join(tmpRoot, 'missing.json'),
    good: path.join(tmpRoot, 'good.json'),
    malformed: path.join(tmpRoot, 'malformed.json'),
  };

  beforeEach(() => {
    fs.writeFileSync(
      paths.good,
      JSON.stringify({
        ports: { gateway: 7001, backend: 7002, mcp: 7003 },
        paths: { projects: '/tmp/projects', state: '/tmp/state' },
        gateway: { url: 'http://127.0.0.1:7001' },
      }),
    );
    fs.writeFileSync(paths.malformed, '{ not: valid');
  });

  afterEach(() => {
    for (const p of Object.values(paths)) if (fs.existsSync(p)) fs.rmSync(p);
  });

  test('returns defaults when config file is absent', () => {
    const cfg = withEnv(
      {
        CORTEX_GATEWAY_PORT: null,
        CORTEX_PLATFORM_PORT: null,
        CORTEX_MCP_PORT: null,
        CORTEX_GATEWAY_URL: null,
      },
      () => loadConfig({ configPath: paths.missing }),
    );
    expect(cfg.ports.gateway).toBe(4840);
    expect(cfg.ports.backend).toBe(4841);
    expect(cfg.ports.mcp).toBe(4842);
    expect(cfg.gateway.url).toBe('http://127.0.0.1:4840');
    expect(typeof cfg.paths.projects).toBe('string');
  });

  test('reads values from the config file when env is unset', () => {
    const cfg = withEnv(
      { CORTEX_GATEWAY_PORT: null, CORTEX_PLATFORM_PORT: null, CORTEX_GATEWAY_URL: null },
      () => loadConfig({ configPath: paths.good }),
    );
    expect(cfg.ports.gateway).toBe(7001);
    expect(cfg.ports.backend).toBe(7002);
    expect(cfg.gateway.url).toBe('http://127.0.0.1:7001');
    expect(cfg.paths.projects).toBe('/tmp/projects');
  });

  test('env overrides file values', () => {
    const cfg = withEnv(
      {
        CORTEX_GATEWAY_PORT: '9001',
        CORTEX_PLATFORM_PORT: '9002',
        CORTEX_GATEWAY_URL: 'http://127.0.0.1:9999',
      },
      () => loadConfig({ configPath: paths.good }),
    );
    expect(cfg.ports.gateway).toBe(9001);
    expect(cfg.ports.backend).toBe(9002);
    expect(cfg.gateway.url).toBe('http://127.0.0.1:9999');
  });

  test('malformed config falls back to defaults without throwing', () => {
    const cfg = withEnv(
      { CORTEX_GATEWAY_PORT: null, CORTEX_PLATFORM_PORT: null, CORTEX_GATEWAY_URL: null },
      () => loadConfig({ configPath: paths.malformed }),
    );
    expect(cfg.ports.gateway).toBe(4840);
    expect(cfg.ports.backend).toBe(4841);
  });
});
