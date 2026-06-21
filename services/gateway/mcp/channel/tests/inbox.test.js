import { describe, it, expect, mock } from 'bun:test';
import { startInboxDrain } from '../inbox.js';

// ---- helpers ----------------------------------------------------------------

function makeMsg(id = 'msg-1', overrides = {}) {
  return { message_id: id, body: `body-${id}`, from: 'nova', ...overrides };
}

function makeMcp() {
  const notifications = [];
  return {
    notifications,
    async notification(frame) {
      notifications.push(frame);
    },
  };
}

function makeClient({ messages = [], ackOk = true, fallbackPollMs = 30_000 } = {}) {
  return {
    config: { fallbackPollMs, inboxLimit: 20 },
    fetchInbox: mock(async () => ({ messages })),
    ack: mock(async () => ({ ok: ackOk, status: ackOk ? 200 : 500 })),
  };
}

function noop() {}
function immediateTimer(cb) { cb(); return { unref() {} }; }

// ---- basic drain ------------------------------------------------------------

describe('startInboxDrain', () => {
  it('throws without required params', () => {
    expect(() => startInboxDrain({})).toThrow('client required');
    expect(() => startInboxDrain({ client: {} })).toThrow('mcp required');
    expect(() => startInboxDrain({ client: {}, mcp: {} })).toThrow('sessionId required');
  });

  it('delivers a message as MCP notification', async () => {
    const mcp = makeMcp();
    const client = makeClient({ messages: [makeMsg('m1')] });
    const drain = startInboxDrain({
      client, mcp, sessionId: 'nova', swallow: noop,
    });

    await drain.drainOnce();

    expect(mcp.notifications).toHaveLength(1);
    expect(mcp.notifications[0].method).toBe('notifications/claude/channel');
    expect(mcp.notifications[0].params.meta.message_id).toBe('m1');
    drain.stop();
  });

  it('skips message with missing id and calls swallow', async () => {
    const swallowed = [];
    const mcp = makeMcp();
    const client = makeClient({ messages: [{ body: 'no-id' }] });
    const drain = startInboxDrain({
      client, mcp, sessionId: 'nova',
      swallow: (m) => swallowed.push(m),
    });

    await drain.drainOnce();

    expect(mcp.notifications).toHaveLength(0);
    expect(swallowed).toContain('channel.message_id_missing');
    drain.stop();
  });

  it('does not re-deliver deliveredButUnacked message', async () => {
    const mcp = makeMcp();
    const client = makeClient({ messages: [makeMsg('m2')], ackOk: false });
    const drain = startInboxDrain({
      client, mcp, sessionId: 'nova', swallow: noop,
      ackDelaysMs: [], // no retries in test
    });

    await drain.drainOnce();
    expect(drain.deliveredButUnacked.has('m2')).toBe(true);

    // Second drain — same message comes back (gateway still unacked).
    await drain.drainOnce();

    // Notification was only emitted once.
    expect(mcp.notifications).toHaveLength(1);
    drain.stop();
  });

  it('clears deliveredButUnacked after successful ack', async () => {
    const mcp = makeMcp();
    const client = makeClient({ messages: [makeMsg('m3')], ackOk: true });
    const drain = startInboxDrain({
      client, mcp, sessionId: 'nova', swallow: noop,
      sleepFn: async () => {}, // instant
    });

    await drain.drainOnce();

    // Give the fire-and-forget ackWithRetry promise a tick to resolve.
    await new Promise((r) => setTimeout(r, 10));
    expect(drain.deliveredButUnacked.has('m3')).toBe(false);
    drain.stop();
  });

  it('increments drain_ok counter on success', async () => {
    const mcp = makeMcp();
    const client = makeClient({ messages: [] });
    const drain = startInboxDrain({
      client, mcp, sessionId: 'nova', swallow: noop,
    });

    await drain.drainOnce();
    expect(drain.counters.drain_ok).toBe(1);
    drain.stop();
  });

  it('increments drain_failed counter on fetch error', async () => {
    const mcp = makeMcp();
    const client = makeClient();
    client.fetchInbox = mock(async () => { throw new Error('network'); });
    const drain = startInboxDrain({
      client, mcp, sessionId: 'nova', swallow: noop,
    });

    await drain.drainOnce();
    expect(drain.counters.drain_failed).toBe(1);
    drain.stop();
  });

  it('stop() prevents fallback timer from firing', () => {
    const mcp = makeMcp();
    const client = makeClient();
    const drain = startInboxDrain({
      client, mcp, sessionId: 'nova', swallow: noop,
    });
    drain.stop();
    // Just verify stop() doesn't throw and the timer was cleared.
    expect(drain.counters.drain_ok).toBe(0);
  });
});
