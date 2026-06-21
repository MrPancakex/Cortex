import { describe, test, expect } from 'bun:test';
import { SocketRegistry } from '../socket/registry.js';

function fakeWs() {
  const ws = {
    readyState: 1,
    closed: false,
    closeCode: null,
    reason: null,
    close(code, reason) {
      this.closed = true;
      this.closeCode = code;
      this.reason = reason;
    },
  };
  return ws;
}

describe('SocketRegistry', () => {
  test('add / remove tracks per-agent sockets', () => {
    const r = new SocketRegistry({ maxPerAgent: 4 });
    const a = fakeWs();
    const b = fakeWs();
    r.add('nova', a);
    r.add('nova', b);
    expect(r.forAgent('nova')).toEqual([a, b]);
    r.remove('nova', a);
    expect(r.forAgent('nova')).toEqual([b]);
  });

  test('evicts the oldest socket when cap is reached', () => {
    const r = new SocketRegistry({ maxPerAgent: 2 });
    const a = fakeWs();
    const b = fakeWs();
    const c = fakeWs();
    r.add('nova', a);
    r.add('nova', b);
    r.add('nova', c); // should evict a
    expect(a.closed).toBe(true);
    expect(a.closeCode).toBe(1013);
    expect(r.forAgent('nova')).toEqual([b, c]);
  });

  test('all() returns every tracked socket across agents', () => {
    const r = new SocketRegistry({ maxPerAgent: 2 });
    const a = fakeWs();
    const b = fakeWs();
    r.add('nova', a);
    r.add('orion', b);
    expect(r.all()).toEqual([a, b]);
  });
});
