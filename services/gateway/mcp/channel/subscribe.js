/**
 * Subscribe to the gateway's event stream for `bridge.sent` deliveries.
 *
 * Lifted from plugins/cortex-channel/subscribe.js and adapted to:
 *   1. Accept a swallow parameter instead of importing from @cortex/sdk,
 *      keeping this file self-contained for tests in /tmp.
 *   2. Remove the heartbeat POST to /v1/api/plugins/cortex-channel/heartbeat
 *      — that endpoint is plugin-registry-specific and not meaningful for
 *      the in-process channel emitter.
 *
 * All reconnect, backoff, polling-fallback, and event-dispatch logic is
 * identical to the plugin version.
 */

const DEFAULT_RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];
const DEFAULT_SUBJECTS = ['bridge.sent'];

function buildStreamUrl(base, cursor, subjects) {
  const wsBase = base.replace(/^http/, 'ws');
  const subjectParam = subjects.map(encodeURIComponent).join(',');
  const qs = cursor
    ? `?since=${encodeURIComponent(cursor)}&subjects=${subjectParam}`
    : `?subjects=${subjectParam}`;
  return `${wsBase}/v1/api/events/stream${qs}`;
}

/**
 * @param {object} opts
 * @param {object}   opts.client                 - createGatewayClient result
 * @param {string}   opts.sessionId
 * @param {string}   opts.baseAgent              - bare agent id (e.g. 'nova')
 * @param {Function} opts.onBridgeSent           - called when a matching event arrives
 * @param {Function} [opts.swallow]              - swallow(metric, err)
 * @param {string[]} [opts.subjects]
 * @param {number[]} [opts.reconnectBackoffMs]
 * @param {Function} [opts.WebSocketImpl]
 */
export async function subscribeToEvents({
  client,
  sessionId,
  baseAgent,
  onBridgeSent,
  swallow = () => {},
  subjects = DEFAULT_SUBJECTS,
  reconnectBackoffMs = DEFAULT_RECONNECT_BACKOFF_MS,
  WebSocketImpl = globalThis.WebSocket,
} = {}) {
  if (!client) throw new Error('subscribeToEvents: client required');
  if (!sessionId) throw new Error('subscribeToEvents: sessionId required');
  if (typeof onBridgeSent !== 'function') {
    throw new Error('subscribeToEvents: onBridgeSent required');
  }

  let cursor = null;
  let ws = null;
  let stopped = false;
  let reconnectIdx = 0;
  let reconnectTimer = null;

  function dispatch(event) {
    if (!event || typeof event !== 'object') return;
    if (event.id) cursor = event.id;
    if (event.subject !== 'bridge.sent') return;
    const target =
      event.payload?.target_session
      || event.payload?.session_id
      || event.payload?.to_session
      || null;
    if (target && target !== sessionId) return;
    const toAgent = event.payload?.to_agent || null;
    if (toAgent && baseAgent && toAgent !== baseAgent) return;
    try {
      onBridgeSent(event);
    } catch (err) {
      swallow('channel.subscribe_dispatch_failed', err);
    }
  }

  async function pollOnce() {
    try {
      const subjectParam = subjects.join(',');
      const qs = cursor
        ? `since=${encodeURIComponent(cursor)}&subjects=${encodeURIComponent(subjectParam)}`
        : `subjects=${encodeURIComponent(subjectParam)}`;
      const data = await client.gatewayGet(`/v1/api/events?${qs}`);
      for (const event of data.events || []) dispatch(event);
    } catch (err) {
      swallow('channel.subscribe_poll_failed', err);
    }
  }

  function scheduleReconnect() {
    if (stopped) return;
    const delay =
      reconnectBackoffMs[Math.min(reconnectIdx, reconnectBackoffMs.length - 1)];
    reconnectIdx += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (stopped) return;
    if (!WebSocketImpl) {
      pollOnce().finally(scheduleReconnect);
      return;
    }
    let socket;
    try {
      socket = new WebSocketImpl(buildStreamUrl(client.config.gatewayUrl, cursor, subjects), {
        headers: {
          'x-cortex-token': client.config.token,
          'x-cortex-session': sessionId,
        },
      });
    } catch (err) {
      swallow('channel.subscribe_ws_construct_failed', err);
      pollOnce().finally(scheduleReconnect);
      return;
    }

    socket.addEventListener?.('open', () => {
      reconnectIdx = 0;
      process.stderr.write(`[cortex-mcp-channel] event stream connected\n`);
    });

    socket.addEventListener?.('message', (msg) => {
      try {
        const event = JSON.parse(msg.data);
        dispatch(event);
      } catch (err) {
        swallow('channel.subscribe_parse_failed', err);
      }
    });

    socket.addEventListener?.('error', (err) => {
      swallow(
        'channel.subscribe_ws_error',
        err instanceof Error ? err : new Error(String(err)),
      );
    });

    socket.addEventListener?.('close', () => {
      ws = null;
      if (!stopped) {
        pollOnce().finally(scheduleReconnect);
      }
    });

    ws = socket;
  }

  connect();

  return {
    stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        try {
          ws.close();
        } catch (err) {
          swallow('channel.subscribe_ws_close', err);
        }
      }
    },
    get cursor() {
      return cursor;
    },
    _dispatchForTests: dispatch,
  };
}

export { buildStreamUrl };
