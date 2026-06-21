import { describe, it, expect, mock } from 'bun:test';
import { subscribeToEvents, buildStreamUrl } from '../subscribe.js';

// ---- helpers ----------------------------------------------------------------

function makeClient(overrides = {}) {
  return {
    config: { gatewayUrl: 'http://127.0.0.1:4840', token: 'tok', fallbackPollMs: 30_000 },
    gatewayGet: mock(async () => ({ events: [] })),
    ...overrides,
  };
}

// Minimal EventEmitter-shaped WebSocket stub.
class FakeWS {
  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    this._listeners = {};
    this.closed = false;
  }
  addEventListener(event, handler) {
    this._listeners[event] = handler;
  }
  emit(event, ...args) {
    this._listeners[event]?.(...args);
  }
  close() {
    this.closed = true;
    this._listeners['close']?.();
  }
}

// ---- buildStreamUrl ---------------------------------------------------------

describe('buildStreamUrl', () => {
  it('converts http to ws and appends subjects', () => {
    const url = buildStreamUrl('http://127.0.0.1:4840', null, ['bridge.sent']);
    expect(url).toBe('ws://127.0.0.1:4840/v1/api/events/stream?subjects=bridge.sent');
  });

  it('appends since cursor when provided', () => {
    const url = buildStreamUrl('http://x', 'cursor-42', ['bridge.sent']);
    expect(url).toContain('since=cursor-42');
  });

  it('converts https to wss', () => {
    const url = buildStreamUrl('https://host', null, ['bridge.sent']);
    expect(url.startsWith('wss://')).toBe(true);
  });
});

// ---- dispatch filtering -----------------------------------------------------

describe('subscribeToEvents dispatch', () => {
  it('calls onBridgeSent for matching bridge.sent event', async () => {
    const fired = [];
    const sub = await subscribeToEvents({
      client: makeClient(),
      sessionId: 'nova',
      baseAgent: 'nova',
      onBridgeSent: (e) => fired.push(e),
      WebSocketImpl: null, // force poll path; no timer fires in this test
    });

    sub._dispatchForTests({
      id: 'evt-1',
      subject: 'bridge.sent',
      payload: { session_id: 'nova' },
    });

    expect(fired).toHaveLength(1);
    expect(fired[0].id).toBe('evt-1');
    sub.stop();
  });

  it('ignores events for other sessions', async () => {
    const fired = [];
    const sub = await subscribeToEvents({
      client: makeClient(),
      sessionId: 'nova',
      baseAgent: 'nova',
      onBridgeSent: (e) => fired.push(e),
      WebSocketImpl: null,
    });

    sub._dispatchForTests({
      id: 'evt-2',
      subject: 'bridge.sent',
      payload: { session_id: 'orion' },
    });

    expect(fired).toHaveLength(0);
    sub.stop();
  });

  it('ignores non-bridge.sent subjects', async () => {
    const fired = [];
    const sub = await subscribeToEvents({
      client: makeClient(),
      sessionId: 'nova',
      baseAgent: 'nova',
      onBridgeSent: (e) => fired.push(e),
      WebSocketImpl: null,
    });

    sub._dispatchForTests({ id: 'e3', subject: 'session.opened', payload: {} });
    expect(fired).toHaveLength(0);
    sub.stop();
  });

  it('ignores events targeted at a different agent', async () => {
    const fired = [];
    const sub = await subscribeToEvents({
      client: makeClient(),
      sessionId: 'nova',
      baseAgent: 'nova',
      onBridgeSent: (e) => fired.push(e),
      WebSocketImpl: null,
    });

    sub._dispatchForTests({
      id: 'e4',
      subject: 'bridge.sent',
      payload: { session_id: 'nova', to_agent: 'scout' },
    });

    expect(fired).toHaveLength(0);
    sub.stop();
  });

  it('updates cursor from event id', async () => {
    const sub = await subscribeToEvents({
      client: makeClient(),
      sessionId: 'nova',
      baseAgent: 'nova',
      onBridgeSent: () => {},
      WebSocketImpl: null,
    });

    sub._dispatchForTests({ id: 'cursor-99', subject: 'bridge.sent', payload: {} });
    expect(sub.cursor).toBe('cursor-99');
    sub.stop();
  });
});

// ---- WS lifecycle -----------------------------------------------------------

describe('subscribeToEvents WebSocket path', () => {
  it('opens WS connection and resets reconnect index on open', async () => {
    let createdWs;
    const FakeWSCapture = class extends FakeWS {
      constructor(...args) {
        super(...args);
        createdWs = this;
      }
    };

    const sub = await subscribeToEvents({
      client: makeClient(),
      sessionId: 'nova',
      baseAgent: 'nova',
      onBridgeSent: () => {},
      WebSocketImpl: FakeWSCapture,
    });

    expect(createdWs).toBeDefined();
    createdWs.emit('open');
    // After open, reconnectIdx resets. Verify no throw.
    sub.stop();
  });

  it('parses JSON messages and dispatches bridge.sent', async () => {
    const fired = [];
    let createdWs;
    const FakeWSCapture = class extends FakeWS {
      constructor(...args) {
        super(...args);
        createdWs = this;
      }
    };

    const sub = await subscribeToEvents({
      client: makeClient(),
      sessionId: 'nova',
      baseAgent: 'nova',
      onBridgeSent: (e) => fired.push(e),
      WebSocketImpl: FakeWSCapture,
    });

    createdWs.emit('message', {
      data: JSON.stringify({ id: 'ws-1', subject: 'bridge.sent', payload: {} }),
    });

    expect(fired).toHaveLength(1);
    sub.stop();
  });
});
