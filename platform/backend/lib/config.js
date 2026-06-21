/**
 * Platform backend configuration loader. The legacy implementation read a
 * JSON file from `~/.cortex-config.json`; the v0.2 rebuild keeps that path
 * but layers environment-variable overrides on top so tests and installers
 * can point the dashboard at a different gateway / port / workspace without
 * editing files on disk.
 *
 * Pure module — only reads when `loadConfig()` is called. No top-level I/O.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  GATEWAY_PORT,
  PLATFORM_PORT,
  resolveProjectsRoot,
  resolveStateRoot,
} from '@cortex/core/constants';
import { swallow } from '@cortex/sdk/errors';

const DEFAULT_CONFIG_PATH =
  process.env.CORTEX_CONFIG_PATH || path.join(os.homedir(), '.cortex-config.json');

function readConfigFile(configPath) {
  try {
    if (!fs.existsSync(configPath)) return {};
    const raw = fs.readFileSync(configPath, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (err) {
    swallow('platform.config_read_failed', err);
    return {};
  }
}

/**
 * Shape:
 * {
 *   ports: { gateway, backend, mcp },
 *   paths: { projects, state },
 *   gateway: { url }
 * }
 *
 * The `backend` port is the dashboard listener (PLATFORM_PORT). Separate
 * from `gateway` because the dashboard and the gateway can — and in prod
 * do — run on different ports under the same loopback host.
 */
export function loadConfig({ configPath = DEFAULT_CONFIG_PATH } = {}) {
  const fileCfg = readConfigFile(configPath);
  const ports = {
    gateway: Number.parseInt(process.env.CORTEX_GATEWAY_PORT || '', 10) || fileCfg.ports?.gateway || GATEWAY_PORT,
    backend: Number.parseInt(process.env.CORTEX_PLATFORM_PORT || '', 10) || fileCfg.ports?.backend || PLATFORM_PORT,
    mcp: Number.parseInt(process.env.CORTEX_MCP_PORT || '', 10) || fileCfg.ports?.mcp || 4842,
  };
  const gatewayUrl =
    process.env.CORTEX_GATEWAY_URL ||
    fileCfg.gateway?.url ||
    `http://127.0.0.1:${ports.gateway}`;
  return {
    ports,
    paths: {
      projects: fileCfg.paths?.projects || resolveProjectsRoot(),
      state: fileCfg.paths?.state || resolveStateRoot(),
      configFile: configPath,
    },
    gateway: { url: gatewayUrl },
  };
}
