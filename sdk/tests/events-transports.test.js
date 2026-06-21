import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDb, runMigrations, resetDbForTests } from '../db/index.js';
import { emit } from '../events/index.js';
import { handleCursorRequest } from '../events/transport-cursor.js';
import {
  parseWsQuery,
  createEventsWsHandler,
} from '../events/transport-ws.js';
import { bus } from '../events/bus.js';

const ROOT = path.join(os.tmpdir(), `cortex-events-transports-${process.pid}`);
const DB_FILE = path.join(ROOT, 'transports.db');

beforeEach(() => {
  resetDbForTests();
  bus._clearForTests();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  process.env.CORTEX_DB_PATH = DB_FILE;
  getDb({ path: DB_FILE });
  runMigrations();
});

afterAll(() => {
  resetDbForTests();
  delete process.env.CORTEX_DB_PATH;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function wait(ms = 20) {
  return new Promise((r) => setTimeout(r, ms));
}

function taskClaimed(uuidSuffix) {
  return emit('task.claimed', {
    task_id: `11111111-2222-4333-8444-555555555${uuidSuffix}`,
    assigned_agent: 'nova-4',
    claimed_at: Date.now(),
  });
}

describe('handleCursorRequest', () => {
  test('returns events beyond since with a next_since pointer', () => {
    taskClaimed('001');
    taskClaimed('002');
    taskClaimed('003');
    const url = new URL('http://localhost/api/events?since=0&subject=task.*&limit=10');
    const result = handleCursorRequest(url);
    expect(result.status).toBe(200);
    expect(result.body.count).toBe(3);
    expect(result.body.subject).toBe('task.*');
    expect(result.body.next_since).toBeGreaterThan(0);
    expect(result.body.events.every((e) => e.subject.startsWith('task.'))).toBe(true);
  });

  test('hard-caps limit at 1000 even if the query requests more', () => {
    // Emit 1005 rows so a limit=99999 request would over-return if the
    // cap weren't enforced. Bounded to keep the test fast — if the cap
    // is raised in the future the assertion tracks it.
    for (let i = 0; i < 1005; i += 1) {
      taskClaimed(`0${String(i).padStart(2, '0')}`.slice(-3));
    }
    const url = new URL('http://localhost/api/events?since=0&limit=99999');
    const result = handleCursorRequest(url);
    expect(result.body.events.length).toBeLessThanOrEqual(1000);
    expect(result.body.count).toBeLessThanOrEqual(1000);
  });

  test('defaults subject to "*" when query param is absent', () => {
    taskClaimed('001');
    const url = new URL('http://localhost/api/events?since=0');
    const result = handleCursorRequest(url);
    expect(result.body.subject).toBe('*');
  });
});

describe('parseWsQuery', () => {
  test('parses subject and since from the URL', () => {
    const url = new URL('ws://localhost/api/events/ws?subject=task.*&since=42');
    expect(parseWsQuery(url)).toEqual({ subject: 'task.*', since: 42 });
  });

  test('defaults to subject="*" and since=0', () => {
    const url = new URL('ws://localhost/api/events/ws');
    expect(parseWsQuery(url)).toEqual({ subject: '*', since: 0 });
  });

  test('rejects non-integer since by falling back to 0', () => {
    const url = new URL('ws://localhost/api/events/ws?since=not-a-number');
    expect(parseWsQuery(url).since).toBe(0);
  });
});

describe('createEventsWsHandler', () => {
  test('backfills historical events on open, then forwards live events, then stops on close', async () => {
    taskClaimed('001');
    taskClaimed('002');

    const sent = [];
    const ws = {
      send(msg) { sent.push(JSON.parse(msg)); },
      close() {},
    };
    const handler = createEventsWsHandler(ws, { subject: 'task.*', since: 0 });
    handler.onOpen();
    await wait(20);
    // Two backfill frames before any live event.
    expect(sent).toHaveLength(2);
    const backfillSeqs = sent.map((e) => e.seq);

    // New emit should be forwarded as a live frame.
    taskClaimed('003');
    await wait(20);
    expect(sent.length).toBeGreaterThanOrEqual(3);
    const live = sent[sent.length - 1];
    expect(live.seq).toBeGreaterThan(Math.max(...backfillSeqs));

    // After onClose, further events are not forwarded.
    handler.onClose();
    const beforeEmit = sent.length;
    taskClaimed('004');
    await wait(20);
    expect(sent.length).toBe(beforeEmit);
  });

  test('onOpen with since=max(seq) attaches live without backfill', async () => {
    const r = taskClaimed('001');
    const sent = [];
    const ws = { send(m) { sent.push(JSON.parse(m)); }, close() {} };
    const handler = createEventsWsHandler(ws, { subject: 'task.*', since: r.seq });
    handler.onOpen();
    await wait(20);
    expect(sent).toHaveLength(0);
    taskClaimed('002');
    await wait(20);
    expect(sent).toHaveLength(1);
    handler.onClose();
  });

  test('backfill + live split exactly partitions events on the onOpen boundary', async () => {
    // Partitioning invariant for review reject #2 (2026-04-22). The fix
    // switched from `backfill(); subscribe()` (which left a publish-to-
    // no-subscriber window between the final getCursor and subscribe
    // registering) to subscribe-first-then-backfill-then-flush. This
    // test proves the partition: events in the DB at onOpen time land
    // via backfill; events after onOpen land via live; each ships
    // exactly once. See the "buffered and delivered exactly once" test
    // below for the tighter invariant — that an emit issued
    // synchronously right after onOpen returns reaches the subscriber,
    // which is only possible if subscribe ran during onOpen.
    const a = taskClaimed('001');
    const b = taskClaimed('002');

    const sent = [];
    const ws = { send(m) { sent.push(JSON.parse(m)); }, close() {} };
    const handler = createEventsWsHandler(ws, { subject: 'task.*', since: 0 });
    handler.onOpen();
    await wait(20);

    // Two backfill frames arrived during onOpen.
    expect(sent.filter((e) => e.subject === 'task.claimed')).toHaveLength(2);

    // Emit after onOpen completes — goes through the live subscription.
    const c = taskClaimed('003');
    await wait(20);

    // Exactly 3 distinct events, no dupes. The seq ordering is preserved.
    const seqs = sent
      .filter((e) => e.subject === 'task.claimed')
      .map((e) => e.seq)
      .sort((x, y) => x - y);
    expect(seqs).toEqual([a.seq, b.seq, c.seq]);

    handler.onClose();
  });

  test('live events emitted during onOpen are buffered and delivered exactly once', async () => {
    // Unit-level proof of the subscribe-first invariant. Before onOpen,
    // put two events in the DB. Call onOpen and, synchronously right
    // after it returns (same JS tick), emit a third — then await. The
    // third MUST be delivered live even though it wasn't in the DB at
    // backfill time.
    taskClaimed('001');
    taskClaimed('002');
    const sent = [];
    const ws = { send(m) { sent.push(JSON.parse(m)); }, close() {} };
    const handler = createEventsWsHandler(ws, { subject: 'task.*', since: 0 });
    handler.onOpen();
    // Synchronously emit — onOpen already registered the subscriber
    // before returning, so this emit publishes to the live handler.
    taskClaimed('003');
    await wait(20);
    const claimed = sent.filter((e) => e.subject === 'task.claimed');
    // 2 from backfill + 1 live = 3; no dupes.
    expect(claimed).toHaveLength(3);
    const unique = new Set(claimed.map((e) => e.seq));
    expect(unique.size).toBe(3);
    handler.onClose();
  });
});
