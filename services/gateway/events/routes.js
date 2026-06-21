/**
 * Gateway events plane. Mounts the two transports the plugin manifests
 * declare as requirements:
 *
 *   GET /v1/api/events           — cursor-style HTTP long-poll fallback
 *   GET /v1/api/events/stream    — WebSocket live stream
 *
 * Ultrareview lens 5 flagged that both plugin manifests
 * (cortex-channel, codex-reviewer) declared `/v1/api/events/stream`
 * under `requires_endpoints`, but no gateway routes.js mounted it.
 * The SDK supplies `transport-ws.js` + `transport-cursor.js`; this
 * plane is the thin wiring that binds them to real URLs.
 *
 * Router shape: WebSocket upgrades are unusual — this file returns a
 * `{ status: 101, upgrade: {...} }` envelope from the handler so the
 * adapter can inspect `upgrade` and wire the WS handshake. Adapters
 * that don't support WS (CLI test harness) return 501 politely
 * instead of crashing.
 */

import {
  handleCursorRequest,
  parseWsQuery,
  createEventsWsHandler,
} from '@cortex/sdk/events';

function cursorHandler(ctx) {
  // Re-hydrate URLSearchParams from ctx.query so the SDK helper can
  // continue treating input as a flat `{ searchParams }` pair.
  const search = new URLSearchParams();
  const query = ctx?.query || {};
  for (const [k, v] of Object.entries(query)) {
    if (v != null) search.set(k, String(v));
  }
  return handleCursorRequest({ searchParams: search });
}

/**
 * WS handler. Returns an `upgrade` marker so Bun Server adapters can
 * hand the request to `Server.upgrade(req, { data })` and bind the
 * per-connection open/close handlers to the factory below.
 *
 * Test adapters that don't drive a real socket receive a 501 unless
 * they pass a synthetic `ctx.ws` (see services/gateway/tests/events-
 * routes-adapter.test.js).
 */
function streamHandler(ctx) {
  const search = new URLSearchParams();
  const query = ctx?.query || {};
  for (const [k, v] of Object.entries(query)) {
    if (v != null) search.set(k, String(v));
  }
  const query2 = parseWsQuery({ searchParams: search });

  // Test path — adapter injected a synthetic ws.
  if (ctx?.ws && typeof ctx.ws.send === 'function') {
    const pair = createEventsWsHandler(ctx.ws, query2);
    return { status: 101, upgrade: { pair, query: query2 } };
  }

  // Real path — surface an `upgrade` marker the Bun Server adapter
  // inspects. The adapter is responsible for invoking `pair.onOpen()`
  // after the upgrade completes and `pair.onClose()` when the socket
  // drops. Returning the factory (not a pre-bound pair) lets the
  // adapter attach its per-connection ws first.
  return {
    status: 101,
    upgrade: {
      kind: 'events_ws',
      query: query2,
      createHandlerPair: (ws) => createEventsWsHandler(ws, query2),
    },
  };
}

/**
 * @param {{ add: (method: string, path: string, handler: Function) => void }} adapter
 */
export function mountEventsRoutes(adapter) {
  if (!adapter || typeof adapter.add !== 'function') {
    throw new Error('mountEventsRoutes: adapter must expose add(method, path, handler)');
  }
  adapter.add('GET', '/v1/api/events', cursorHandler);
  adapter.add('GET', '/v1/api/events/stream', streamHandler);
}
