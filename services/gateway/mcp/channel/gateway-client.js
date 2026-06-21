/**
 * HTTP client for gateway interaction from the in-process channel emitter.
 *
 * Lifted from plugins/cortex-channel/gateway-client.js and adapted:
 *   - config.token  (plugin field name used here matches original)
 *   - config.inboxLimit
 *   - config.fallbackPollMs
 *   - config.gatewayUrl
 *
 * The caller (channel/index.js) builds a channel-config object with these
 * exact field names before passing it here, bridging from the bootstrap
 * config's `agentToken` / `gatewayUrl` names.
 *
 * No imports from @cortex/sdk here — this file is also loaded directly by
 * the self-contained unit tests in channel/tests/.
 */

const DEFAULT_TIMEOUT_MS = 10_000;

function buildHeaders(config, sessionId) {
  return {
    'content-type': 'application/json',
    'x-cortex-token': config.token,
    'x-cortex-session': sessionId,
    'x-cortex-plugin': 'cortex-channel',
  };
}

function swallowSilent(err) {
  void err; // callers pass their own swallow; this is only used when none given
}

async function withTimeout(makeRequest, timeoutMs, onAbort = swallowSilent) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await makeRequest(controller.signal);
  } catch (err) {
    onAbort(err);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function createGatewayClient({
  config,
  sessionId,
  fetchFn = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!config) throw new Error('createGatewayClient: config required');
  if (!sessionId) throw new Error('createGatewayClient: sessionId required');
  const headers = buildHeaders(config, sessionId);

  async function gatewayGet(path) {
    return withTimeout(
      async (signal) => {
        const res = await fetchFn(`${config.gatewayUrl}${path}`, {
          method: 'GET',
          headers,
          signal,
        });
        if (!res.ok) {
          throw new Error(`GET ${path} → ${res.status}`);
        }
        return res.json();
      },
      timeoutMs,
    );
  }

  async function gatewayPost(path, body) {
    return withTimeout(
      async (signal) =>
        fetchFn(`${config.gatewayUrl}${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        }),
      timeoutMs,
    );
  }

  async function fetchInbox({ limit = config.inboxLimit } = {}) {
    const path =
      `/v1/api/bridge/inbox/${encodeURIComponent(sessionId)}`
      + `?unread_only=true&mark_read=false&limit=${limit}`;
    return gatewayGet(path);
  }

  async function ack(messageId) {
    return gatewayPost(
      `/v1/api/bridge/ack/${encodeURIComponent(messageId)}`,
      {},
    );
  }

  return {
    config,
    sessionId,
    gatewayGet,
    gatewayPost,
    fetchInbox,
    ack,
  };
}
