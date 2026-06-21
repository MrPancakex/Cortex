/**
 * Canonical port assignments. Overridable via env, but the defaults are the
 * source of truth — docs, installers, and tests all read from here.
 */
function intEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 && n < 65_536 ? n : fallback;
}

export const GATEWAY_PORT = intEnv('CORTEX_GATEWAY_PORT', 4840);
export const PLATFORM_PORT = intEnv('CORTEX_PLATFORM_PORT', 4841);
export const MCP_PORT = intEnv('CORTEX_MCP_PORT', 4842);

// Localhost base URL derived from GATEWAY_PORT. Exported so plugins +
// supervisor can drop hardcoded `http://127.0.0.1:4840` strings —
// ultrareview lens 1 found three spots that diverged from the port
// constant (one env override away from silently pointing to the wrong
// gateway).
export const GATEWAY_LOCAL_URL = `http://127.0.0.1:${GATEWAY_PORT}`;

export const PORTS = Object.freeze({
  gateway: GATEWAY_PORT,
  platform: PLATFORM_PORT,
  mcp: MCP_PORT,
});
