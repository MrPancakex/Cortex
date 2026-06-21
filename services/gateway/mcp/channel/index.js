/**
 * Channel emitter for the in-process stdio MCP server.
 *
 * Exports a single function: mountChannelEmit({ mcp, sessionId, baseAgent,
 * token, gatewayUrl, fallbackPollMs, inboxLimit }).
 *
 * Call this AFTER `await server.connect(transport)` so the notification
 * transport is live when the initial drain fires. The returned handle's
 * stop() method is wired into stdio.js's existing cleanup/signal path.
 *
 * DEVIATION from task spec (step 1 — session pointer resolution):
 *   The spec described resolving sessionId from a pointer file. That
 *   complexity exists in session.js ONLY to bridge the cross-process ppid
 *   gap between the supervisor-spawned plugin and the CC-spawned stdio
 *   server. Here the channel emitter runs INSIDE the stdio process, so the
 *   session id is already known (it IS gateway.config.agentId). We pass it
 *   directly. No pointer-file scan needed.
 *
 * DEVIATION from task spec (step 2 — call resolveAgentToken here):
 *   The token is already resolved by stdio-bootstrap.js. We forward
 *   gateway.config.agentToken rather than re-invoking the resolver.
 *   If agentToken is null (bootstrap swallowed the failure), mountChannelEmit
 *   logs a warning and returns a no-op stop() rather than crashing the MCP
 *   server.
 *
 * SCALING NOTE (per 2026-05-29):
 *   Each CC session opens its own WS connection to /v1/api/events/stream.
 *   At N=2-4 agents the gateway fan-out is trivial.
 *   If the agent fleet grows past ~10 concurrent sessions, consider a
 *   shared gateway-side subscriber that distributes to in-process MCP
 *   servers via an internal pub/sub instead of per-session WS.
 */

import { createGatewayClient } from './gateway-client.js';
import { startInboxDrain } from './inbox.js';
import { subscribeToEvents } from './subscribe.js';

const DEFAULT_FALLBACK_POLL_MS = 30_000;
const DEFAULT_INBOX_LIMIT = 20;

/**
 * @param {object} opts
 * @param {object} opts.mcp             - MCP Server instance (post-connect)
 * @param {string} opts.sessionId       - Agent session id, e.g. "nova" or "nova-2"
 * @param {string} opts.baseAgent       - Bare agent id, e.g. "nova"
 * @param {string|null} opts.token      - Bearer token; null → skip, emit warning
 * @param {string} opts.gatewayUrl      - e.g. "http://127.0.0.1:4840"
 * @param {Function} [opts.swallow]     - swallow(metric, err) injected by stdio.js
 * @param {number} [opts.fallbackPollMs]
 * @param {number} [opts.inboxLimit]
 * @param {Function} [opts.fetchFn]     - Injected for tests
 * @param {Function} [opts.WebSocketImpl] - Injected for tests
 * @returns {{ stop(): void }}
 */
export async function mountChannelEmit({
  mcp,
  sessionId,
  baseAgent,
  token,
  gatewayUrl,
  swallow = () => {},
  fallbackPollMs = DEFAULT_FALLBACK_POLL_MS,
  inboxLimit = DEFAULT_INBOX_LIMIT,
  fetchFn = undefined,
  WebSocketImpl = undefined,
} = {}) {
  if (!mcp) throw new Error('mountChannelEmit: mcp required');
  if (!sessionId) throw new Error('mountChannelEmit: sessionId required');
  if (!gatewayUrl) throw new Error('mountChannelEmit: gatewayUrl required');

  if (!token) {
    process.stderr.write(
      `[cortex-mcp-channel] WARNING: no agent token — channel notifications disabled\n`,
    );
    return { stop() {} };
  }

  const channelConfig = {
    token,
    gatewayUrl,
    fallbackPollMs,
    inboxLimit,
  };

  const clientOpts = { config: channelConfig, sessionId };
  if (fetchFn !== undefined) clientOpts.fetchFn = fetchFn;
  const client = createGatewayClient(clientOpts);

  const inbox = startInboxDrain({ client, mcp, sessionId, swallow });

  const subscribeOpts = {
    client,
    sessionId,
    baseAgent,
    onBridgeSent: () => inbox.trigger(),
    swallow,
  };
  if (WebSocketImpl !== undefined) subscribeOpts.WebSocketImpl = WebSocketImpl;
  const subscription = await subscribeToEvents(subscribeOpts);

  // Initial drain — pick up messages that arrived before the channel started.
  inbox.trigger();

  process.stderr.write(
    `[cortex-mcp-channel] ready session=${sessionId} agent=${baseAgent}\n`,
  );

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      inbox.stop();
      subscription.stop();
      process.stderr.write(`[cortex-mcp-channel] stopped (${sessionId})\n`);
    },
  };
}
