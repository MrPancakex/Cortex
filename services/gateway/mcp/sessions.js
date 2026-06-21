import { swallow } from '@cortex/sdk/errors';

const MAX_SESSIONS = Number(process.env.CORTEX_MCP_MAX_SESSIONS || 100);
const SESSION_TTL_MS = Number(process.env.CORTEX_MCP_SESSION_TTL_MS || 3_600_000);

export const sessions = new Map();               // sessionId -> BunSSETransport
export const sessionLastActiveAt = new Map();    // sessionId -> timestamp (ms)

export { MAX_SESSIONS, SESSION_TTL_MS };

/**
 * Write a payload to an SSE session. If the writer throws (EPIPE, dead client)
 * mark the session closed, log, increment mcp_sse_write_failed, and ensure
 * close/onclose are only ever invoked once.
 */
export async function writeSseOrClose(session, payload) {
  if (session.closed) return;
  try {
    await session.writer.write(payload);
  } catch (err) {
    swallow('mcp_sse_write_failed', err);
    console.warn(`[mcp] SSE write failed for session ${session.id || 'unknown'}: ${err.message}`);
    session.closed = true;
    try { session.onclose?.(); } catch (err2) { swallow('mcp_sse_onclose_threw', err2); }
    try { await session.writer.close?.(); } catch (err2) { swallow('mcp_sse_close_threw', err2); }
  }
}

/**
 * Renew the last-active timestamp for a session. No-op if the session has
 * already been reaped.
 */
export function touchSession(sessionId) {
  if (sessions.has(sessionId)) sessionLastActiveAt.set(sessionId, Date.now());
}

export function countSessions() { return sessions.size; }
export function hasSession(id) { return sessions.has(id); }
export function getSession(id) { return sessions.get(id); }
export function storeSession(id, transport) {
  sessions.set(id, transport);
  sessionLastActiveAt.set(id, Date.now());
}
export function dropSession(id) {
  sessions.delete(id);
  sessionLastActiveAt.delete(id);
}

export function reapStaleSessions(now = Date.now()) {
  let reaped = 0;
  for (const [id, lastActive] of sessionLastActiveAt) {
    if (now - lastActive > SESSION_TTL_MS) {
      const transport = sessions.get(id);
      if (transport) {
        try { transport.close(); } catch (err) { swallow('mcp_session_close_failed', err); }
      }
      dropSession(id);
      reaped += 1;
    }
  }
  return reaped;
}

// Periodic reaper: sweeps sessions idle longer than SESSION_TTL_MS.
// Activity (POST /mcp/message, SSE keepalive) renews last-active via
// touchSession(), so a busy session never expires.
const _reaper = setInterval(() => {
  reapStaleSessions();
}, 60_000);
if (_reaper.unref) _reaper.unref();
