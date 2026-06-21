/**
 * Session identity resolution — the gateway-side wrapper around
 * sdk/sessions/id.js. The sdk primitive is the source of truth for
 * session-slot formatting and PID-based reverse lookup; this file adds
 * a thin caller-friendly surface that:
 *
 *   1. Defaults runDir to sdk/sessions's `defaultRunDir()` when the caller
 *      passes nothing — same precedence order as the legacy resolver
 *      (CORTEX_RUN_DIR → CORTEX_HOME/data/run → repo-relative).
 *   2. Exposes a small helper for "parse a session id back into its base
 *      agent and slot number" — used by the reaper and slot-registry
 *      when they receive a session_id in an event payload and need to
 *      dispatch by base agent.
 *
 * Every piece of session-id logic that a handler would need lives here;
 * other plane files never import directly from sdk/sessions so Rule 4
 * (one public entry per sub-module) holds in both directions.
 */

import {
  formatSessionId as sdkFormatSessionId,
  resolveSessionId as sdkResolveSessionId,
  defaultRunDir,
} from '@cortex/sdk/sessions';

/**
 * `formatSessionId('nova', 1)` → `'nova'`
 * `formatSessionId('nova', 3)` → `'nova-3'`
 */
export function formatSessionId(baseAgent, slot) {
  return sdkFormatSessionId(baseAgent, slot);
}

/**
 * Resolve the canonical session id for a PID under a given base agent,
 * by scanning the lease directory. Returns `{ sessionId, n, found }` —
 * when `found` is false, `sessionId` falls back to `baseAgent` so the
 * caller always has SOMETHING to use as a routing key.
 *
 * @param {{ baseAgent: string, pid?: number, runDir?: string }} args
 */
export function resolveSessionId(args) {
  const baseAgent = args?.baseAgent;
  if (typeof baseAgent !== 'string' || baseAgent.length === 0) {
    throw new Error('resolveSessionId: baseAgent must be a non-empty string');
  }
  const pid = Number.isInteger(args.pid) ? args.pid : process.pid;
  const runDir = args.runDir || defaultRunDir();
  return sdkResolveSessionId(runDir, baseAgent, pid);
}

/**
 * Parse a session id back into its base agent + slot number.
 *
 * Input shapes:
 *   `'nova'`    → `{ baseAgent: 'nova', slot: 1 }`
 *   `'nova-3'`  → `{ baseAgent: 'nova', slot: 3 }`
 *
 * The spec keeps slot-1 bare (no `-1` suffix), so anything WITHOUT a
 * trailing `-N` segment is slot 1. Returns null if the input is not a
 * string or is empty.
 *
 * @param {string} sessionId
 * @returns {{ baseAgent: string, slot: number } | null}
 */
export function parseSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  // Match the LAST hyphen-separated digit group — multi-segment base ids
  // like `codex-worker` still resolve correctly to their slot.
  const m = sessionId.match(/^(.+?)-(\d+)$/);
  if (m) {
    const slot = parseInt(m[2], 10);
    if (Number.isInteger(slot) && slot >= 1) {
      return { baseAgent: m[1], slot };
    }
  }
  return { baseAgent: sessionId, slot: 1 };
}

export { defaultRunDir };
