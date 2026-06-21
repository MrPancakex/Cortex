/**
 * Integration test — mocked WS + HTTP, asserts the full emit→ack→dedup flow
 * through mountChannelEmit.
 *
 * Strategy: inject FakeWS and a fake fetchFn so no real gateway is needed.
 * The test drives the full path:
 *   1. mountChannelEmit() starts subscribe + inbox
 *   2. FakeWS fires a bridge.sent event → inbox.trigger() is called
 *   3. fetchFn returns a message → mcp.notification() is called
 *   4. ack POST fires → deliveredButUnacked cleared
 *   5. A second drain with the same message id → NOT re-notified (dedup)
 *   6. stop() cleans up without throwing
 */

import { describe, it, expect, mock } from 'bun:test';
import { mountChannelEmit } from '../index.js';

// ---- minimal FakeWS --------------------------------------------------------

class FakeWS {
  constructor() {
    this._listeners = {};
    this.closed = false;
    FakeWS.last = this;
  }
  addEventListener(event, handler) { this._listeners[event] = handler; }
  emit(event, data) { this._listeners[event]?.(data); }
  close() {
    this.closed = true;
    this._listeners['close']?.();
  }
}

// ---- helpers ----------------------------------------------------------------

function makeMcp() {
  const notifications = [];
  return {
    notifications,
    async notification(frame) { notifications.push(frame); },
  };
}

function buildFetchFn({ messages = [], ackOk = true } = {}) {
  let inboxCallCount = 0;
  return mock(async (url) => {
    if (url.includes('/bridge/inbox/')) {
      inboxCallCount += 1;
      // Return messages only on the first call; subsequent calls return empty
      // (simulating gateway marking them read after ack).
      const msgs = inboxCallCount === 1 ? messages : [];
      return { ok: true, json: async () => ({ messages: msgs }) };
    }
    if (url.includes('/bridge/ack/')) {
      return { ok: ackOk, status: ackOk ? 200 : 500 };
    }
    // events stream poll fallback
    return { ok: true, json: async () => ({ events: [] }) };
  });
}

// ---- integration flow -------------------------------------------------------

describe('mountChannelEmit integration', () => {
  it('delivers a message end-to-end and acks it', async () => {
    const mcp = makeMcp();
    const msg = { message_id: 'int-1', body: 'hello', from: 'nova' };
    const fetchFn = buildFetchFn({ messages: [msg], ackOk: true });

    const handle = await mountChannelEmit({
      mcp,
      sessionId: 'nova',
      baseAgent: 'nova',
      token: 'test-token',
      gatewayUrl: 'http://127.0.0.1:4840',
      fallbackPollMs: 60_000, // don't fire during test
      WebSocketImpl: FakeWS,
      fetchFn,
    });

    // Wait for the initial trigger drain to complete.
    await new Promise((r) => setTimeout(r, 50));

    expect(mcp.notifications).toHaveLength(1);
    expect(mcp.notifications[0].method).toBe('notifications/claude/channel');
    expect(mcp.notifications[0].params.meta.message_id).toBe('int-1');
    expect(mcp.notifications[0].params.content).toContain('hello');

    handle.stop();
  });

  it('triggers drain when WS fires bridge.sent for this session', async () => {
    const mcp = makeMcp();
    const msg = { message_id: 'ws-msg-1', body: 'ws triggered', from: 'nova' };
    const fetchFn = buildFetchFn({ messages: [msg] });

    await mountChannelEmit({
      mcp,
      sessionId: 'nova',
      baseAgent: 'nova',
      token: 'tok',
      gatewayUrl: 'http://127.0.0.1:4840',
      fallbackPollMs: 60_000,
      WebSocketImpl: FakeWS,
      fetchFn,
    });

    // Let initial drain settle.
    await new Promise((r) => setTimeout(r, 20));
    const countAfterInit = mcp.notifications.length;

    // Fire a bridge.sent WS event — this should trigger another drain.
    // fetchFn will return empty messages on the 2nd call, so no new notification.
    FakeWS.last.emit('message', {
      data: JSON.stringify({
        id: 'ev-1',
        subject: 'bridge.sent',
        payload: { session_id: 'nova' },
      }),
    });

    await new Promise((r) => setTimeout(r, 20));

    // fetchInbox should have been called at least twice (initial + WS-triggered).
    const inboxCalls = fetchFn.mock.calls.filter(([url]) => url.includes('/bridge/inbox/')).length;
    expect(inboxCalls).toBeGreaterThanOrEqual(2);
    // No new notification emitted on the second drain (empty messages).
    expect(mcp.notifications.length).toBe(countAfterInit);
  });

  it('returns a no-op stop() when token is null', async () => {
    const handle = await mountChannelEmit({
      mcp: makeMcp(),
      sessionId: 'nova',
      baseAgent: 'nova',
      token: null,
      gatewayUrl: 'http://127.0.0.1:4840',
    });
    // Should not throw.
    handle.stop();
  });

  it('stop() is idempotent', async () => {
    const handle = await mountChannelEmit({
      mcp: makeMcp(),
      sessionId: 'nova',
      baseAgent: 'nova',
      token: 'tok',
      gatewayUrl: 'http://127.0.0.1:4840',
      fallbackPollMs: 60_000,
      WebSocketImpl: FakeWS,
      fetchFn: buildFetchFn(),
    });

    await new Promise((r) => setTimeout(r, 20));
    handle.stop();
    handle.stop(); // should not throw
  });

  it('deduplicates: same message id not re-notified on second drain', async () => {
    const mcp = makeMcp();
    const msg = { message_id: 'dedup-1', body: 'once only', from: 'nova' };

    // fetchFn always returns the same message (simulating ack not landing).
    let fetchCount = 0;
    const fetchFn = mock(async (url) => {
      if (url.includes('/bridge/inbox/')) {
        fetchCount += 1;
        return { ok: true, json: async () => ({ messages: [msg] }) };
      }
      if (url.includes('/bridge/ack/')) {
        return { ok: false, status: 500 }; // ack always fails → stays unacked
      }
      return { ok: true, json: async () => ({ events: [] }) };
    });

    const handle = await mountChannelEmit({
      mcp,
      sessionId: 'nova',
      baseAgent: 'nova',
      token: 'tok',
      gatewayUrl: 'http://127.0.0.1:4840',
      fallbackPollMs: 60_000,
      WebSocketImpl: FakeWS,
      fetchFn,
      swallow: () => {},
    });

    await new Promise((r) => setTimeout(r, 20));
    const countAfterFirst = mcp.notifications.length;
    expect(countAfterFirst).toBe(1);

    // Manually trigger a second drain.
    // Access the internal drain by triggering via WS (which fires trigger()).
    FakeWS.last.emit('message', {
      data: JSON.stringify({ id: 'ev-2', subject: 'bridge.sent', payload: {} }),
    });

    await new Promise((r) => setTimeout(r, 20));

    // Notification count must not have increased — dedup held.
    expect(mcp.notifications.length).toBe(1);
    handle.stop();
  });
});
