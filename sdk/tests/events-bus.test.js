import { describe, test, expect, beforeEach } from 'bun:test';
import { Bus } from '../events/bus.js';
import {
  bumpOverflow,
  getOverflowCounters,
  resetOverflowCounters,
} from '../events/overflow.js';

beforeEach(() => {
  resetOverflowCounters();
});

function wait(ms = 0) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('Bus subscribe/publish', () => {
  test('delivers an event to an exact-subject subscriber', async () => {
    const bus = new Bus();
    const seen = [];
    bus.register('task.claimed', (e) => { seen.push(e); });
    bus.publish({ subject: 'task.claimed', payload: {} });
    await wait(10);
    expect(seen).toHaveLength(1);
    expect(seen[0].subject).toBe('task.claimed');
  });

  test('glob "task.*" matches every subject under the task namespace', async () => {
    const bus = new Bus();
    const seen = [];
    bus.register('task.*', (e) => { seen.push(e.subject); });
    bus.publish({ subject: 'task.claimed' });
    bus.publish({ subject: 'task.approved' });
    bus.publish({ subject: 'session.opened' });
    await wait(10);
    expect(seen.sort()).toEqual(['task.approved', 'task.claimed']);
  });

  test('glob "*" matches everything', async () => {
    const bus = new Bus();
    const seen = [];
    bus.register('*', (e) => { seen.push(e.subject); });
    bus.publish({ subject: 'a.b' });
    bus.publish({ subject: 'c.d' });
    await wait(10);
    expect(seen.sort()).toEqual(['a.b', 'c.d']);
  });

  test('unsubscribe stops future delivery', async () => {
    const bus = new Bus();
    const seen = [];
    const off = bus.register('*', (e) => { seen.push(e); });
    bus.publish({ subject: 'x.y' });
    await wait(10);
    off();
    bus.publish({ subject: 'x.y' });
    await wait(10);
    expect(seen).toHaveLength(1);
  });

  test('rejects a non-string subjectGlob and non-function handler', () => {
    const bus = new Bus();
    expect(() => bus.register('', () => {})).toThrow(/non-empty string/);
    expect(() => bus.register('a.b', 'not a function')).toThrow(/must be a function/);
  });

  test('handler errors do not stop delivery to other subscribers', async () => {
    const bus = new Bus();
    const seen = [];
    bus.register('*', () => { throw new Error('boom'); }, { id: 'bad' });
    bus.register('*', (e) => { seen.push(e); }, { id: 'good' });
    bus.publish({ subject: 'x.y' });
    await wait(10);
    expect(seen).toHaveLength(1);
  });
});

describe('Bus overflow', () => {
  test('drops events once a subscriber queue is full and bumps the overflow counter', async () => {
    const bus = new Bus();
    let resolveHold;
    const hold = new Promise((r) => { resolveHold = r; });
    // Slow handler that parks until we release it — the queue fills while it's stuck.
    bus.register('*', async () => { await hold; }, { id: 'slow', maxQueue: 3 });
    for (let i = 0; i < 10; i += 1) bus.publish({ subject: 'x.y', i });
    // Allow the initial event to enter the handler (queue holds the rest).
    await wait(5);
    expect(getOverflowCounters().slow).toBeGreaterThan(0);
    resolveHold();
    await wait(20);
  });
});

describe('overflow counters', () => {
  test('bumpOverflow + getOverflowCounters round-trip', () => {
    bumpOverflow('sub-a');
    bumpOverflow('sub-a');
    bumpOverflow('sub-b');
    const c = getOverflowCounters();
    expect(c['sub-a']).toBe(2);
    expect(c['sub-b']).toBe(1);
  });
});
