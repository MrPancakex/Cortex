/**
 * Inbox drain loop with retry + ack-failure handling.
 *
 * Lifted from plugins/cortex-channel/inbox.js and adapted to:
 *   1. Import formatMessage/buildMeta from the local channel/ format.js
 *      rather than a relative path to the plugin.
 *   2. Use a swallow parameter rather than the @cortex/sdk import, so
 *      this file remains self-contained for tests running in /tmp.
 *
 * The drain + ack + dedup semantics are identical to the plugin version.
 * The fallback-poll timer interval comes from client.config.fallbackPollMs.
 */

import { formatMessage, buildMeta } from './format.js';

const DEFAULT_ACK_DELAYS_MS = [1000, 2000, 4000, 8000];

function messageIdOf(msg) {
  return msg?.message_id || msg?.id || msg?.messageId || null;
}

/**
 * @param {object} opts
 * @param {object} opts.client       - createGatewayClient result
 * @param {object} opts.mcp          - MCP server (has .notification())
 * @param {string} opts.sessionId
 * @param {Function} [opts.swallow]  - swallow(metric, err) — defaults to no-op
 * @param {number[]} [opts.ackDelaysMs]
 * @param {Function} [opts.sleepFn]
 */
export function startInboxDrain({
  client,
  mcp,
  sessionId,
  swallow = () => {},
  ackDelaysMs = DEFAULT_ACK_DELAYS_MS,
  sleepFn = null,
} = {}) {
  if (!client) throw new Error('startInboxDrain: client required');
  if (!mcp) throw new Error('startInboxDrain: mcp required');
  if (!sessionId) throw new Error('startInboxDrain: sessionId required');

  const sleep = sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));

  let draining = false;
  let firstFailureLogged = false;
  const deliveredButUnacked = new Set();

  const counters = {
    channel_ack_failed: 0,
    drain_ok: 0,
    drain_failed: 0,
  };

  async function ackWithRetry(messageId) {
    for (let attempt = 0; attempt < ackDelaysMs.length; attempt++) {
      try {
        const res = await client.ack(messageId);
        if (res && res.ok) {
          deliveredButUnacked.delete(messageId);
          return true;
        }
        counters.channel_ack_failed += 1;
        const status = res ? res.status : 'no-response';
        if (attempt === ackDelaysMs.length - 1) {
          const err = new Error(
            `ack failed for ${messageId} after ${ackDelaysMs.length} attempts (status ${status})`,
          );
          swallow('channel.ack_exhausted', err);
          process.stderr.write(`[cortex-mcp-channel] ${err.message}\n`);
          return false;
        }
      } catch (err) {
        counters.channel_ack_failed += 1;
        swallow('channel.ack_threw', err);
        if (attempt === ackDelaysMs.length - 1) {
          process.stderr.write(
            `[cortex-mcp-channel] ack failed for ${messageId} after ${ackDelaysMs.length} attempts: ${err.message}\n`,
          );
          return false;
        }
      }
      await sleep(ackDelaysMs[attempt]);
    }
    return false;
  }

  async function drainOnce() {
    if (draining) return;
    draining = true;
    try {
      const data = await client.fetchInbox();
      firstFailureLogged = false;
      counters.drain_ok += 1;
      const messages = (data && data.messages) || [];
      if (messages.length === 0) return;

      let delivered = 0;
      for (const msg of messages) {
        const messageId = messageIdOf(msg);
        if (!messageId) {
          swallow('channel.message_id_missing', new Error('bridge message missing id'));
          continue;
        }
        if (deliveredButUnacked.has(messageId)) {
          ackWithRetry(messageId).catch((err) => swallow('channel.ack_background', err));
          continue;
        }
        try {
          await mcp.notification({
            method: 'notifications/claude/channel',
            params: {
              content: formatMessage(msg),
              meta: buildMeta(msg),
            },
          });
        } catch (err) {
          swallow('channel.notify_failed', err);
          process.stderr.write(`[cortex-mcp-channel] notification failed: ${err.message}\n`);
          continue;
        }

        delivered += 1;
        deliveredButUnacked.add(messageId);
        ackWithRetry(messageId).catch((err) => swallow('channel.ack_background', err));
      }
      if (delivered > 0) {
        process.stderr.write(`[cortex-mcp-channel] delivered ${delivered} message(s)\n`);
      }
    } catch (err) {
      counters.drain_failed += 1;
      swallow('channel.drain_failed', err);
      if (!firstFailureLogged) {
        process.stderr.write(
          `[cortex-mcp-channel] drain error (first of outage): ${err.message}\n`,
        );
        firstFailureLogged = true;
      }
    } finally {
      draining = false;
    }
  }

  const fallbackTimer = setInterval(
    () => drainOnce().catch((err) => swallow('channel.fallback_poll', err)),
    client.config.fallbackPollMs,
  );

  return {
    trigger() {
      drainOnce().catch((err) => swallow('channel.trigger_failed', err));
    },
    drainOnce,
    counters,
    deliveredButUnacked,
    stop() {
      clearInterval(fallbackTimer);
    },
  };
}
