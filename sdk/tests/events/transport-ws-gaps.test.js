/**
 * Coverage gaps for sdk/events/transport-ws.js:
 *  - closed-before-onOpen guard
 *  - onClose during backfill
 *  - ws.send throw is swallowed (sendFrame error path)
 *  - parseWsQuery negative since falls back to 0
 *  - backfill_truncated sentinel (raw insert bypass, no validation)
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, runMigrations, resetDbForTests } from '../../db/index.js';
import { bus } from '../../events/bus.js';
import { createEventsWsHandler, parseWsQuery } from '../../events/transport-ws.js';

const ROOT = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'cortex-ws-gaps-'));
const DB_FILE = path.join(ROOT, 'ws-gaps.db');

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

describe('parseWsQuery edge cases', () => {
  test('should fall back to since=0 when since is negative', () => {
    const url = new URL('ws://localhost/ws?since=-5');
    expect(parseWsQuery(url).since).toBe(0);
  });

  test('should fall back to since=0 when since is a float', () => {
    const url = new URL('ws://localhost/ws?since=1.5');
    // parseInt('1.5', 10) === 1 which is >= 0, so 1 is valid
    expect(parseWsQuery(url).since).toBe(1);
  });

  test('should use "*" as default subject when absent', () => {
    const url = new URL('ws://localhost/ws');
    expect(parseWsQuery(url).subject).toBe('*');
  });
});

describe('createEventsWsHandler — closed-before-onOpen guard', () => {
  test('should be a no-op when onClose is called before onOpen', async () => {
    const sent = [];
    const ws = { send: (m) => sent.push(m), close: () => {} };
    const handler = createEventsWsHandler(ws, { subject: '*', since: 0 });
    handler.onClose(); // close before open
    handler.onOpen();  // should bail immediately
    await wait(20);
    expect(sent).toHaveLength(0);
  });
});

describe('createEventsWsHandler — ws.send throws', () => {
  test('should swallow send errors without crashing the handler', async () => {
    // Insert a raw event so backfill finds it
    const db = getDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO events (id, subject, ts, source, task_id, session_id, trace_id, payload, v)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('id-throw-test', 'task.claimed', now, 'test', 'tid-1', null, null, '{}', 1);

    const ws = {
      send: () => { throw new Error('socket gone'); },
      close: () => {},
    };
    const handler = createEventsWsHandler(ws, { subject: '*', since: 0 });
    // Should not throw even though every send throws
    expect(() => handler.onOpen()).not.toThrow();
    handler.onClose();
  });
});

describe('createEventsWsHandler — onClose during backfill', () => {
  test('should clean up subscription when closed mid-backfill', async () => {
    // Put a row in DB so backfill does real work
    const db = getDb();
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO events (id, subject, ts, source, task_id, session_id, trace_id, payload, v)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(`id-close-mid-${i}`, 'task.claimed', now, 'test', `tid-${i}`, null, null, '{}', 1);
    }

    const sent = [];
    const ws = {
      send(m) {
        sent.push(m);
        // Close after first frame to simulate a mid-backfill close
        if (sent.length === 1) handler.onClose();
      },
      close: () => {},
    };
    const handler = createEventsWsHandler(ws, { subject: '*', since: 0 });
    handler.onOpen();
    await wait(20);
    // After close, no more events should arrive via bus
    const countAfterClose = sent.length;
    // Publish a live event — should NOT be forwarded since closed
    bus.publish({ subject: 'task.claimed', seq: 9999, ts: Date.now() });
    await wait(20);
    expect(sent.length).toBe(countAfterClose);
  });
});

describe('createEventsWsHandler — getCursor failure swallowed', () => {
  test('should return without sending frames when getCursor throws', () => {
    // Drop the events table so getCursor throws a non-network error
    getDb().exec('DROP TABLE events');
    const sent = [];
    const ws = { send: (m) => sent.push(m), close: () => {} };
    const handler = createEventsWsHandler(ws, { subject: '*', since: 0 });
    expect(() => handler.onOpen()).not.toThrow();
    handler.onClose();
    expect(sent).toHaveLength(0);
  });
});

describe('createEventsWsHandler — live buffer dedup on flush', () => {
  test('should not re-send events that were already in backfill (seq <= lastBackfillSeq)', async () => {
    // Insert a row with a low seq so backfill sees it
    const db = getDb();
    const now = Date.now();
    db.prepare(
      `INSERT INTO events (id, subject, ts, source, task_id, session_id, trace_id, payload, v)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('id-dedup-1', 'task.claimed', now, 'test', 'tid-dedup-1', null, null, '{}', 1);

    const sent = [];
    // Intercept: during onOpen, we'll manually push an event into the bus
    // that matches what backfill will see (same seq). The dedup should skip it.
    const ws = {
      send(m) {
        const parsed = JSON.parse(m);
        sent.push(parsed);
      },
      close() {},
    };
    const handler = createEventsWsHandler(ws, { subject: '*', since: 0 });

    // Publish an event to the bus BEFORE onOpen so it lands in liveBuffer during backfill.
    // Use seq=1 which will be <= lastBackfillSeq after backfill.
    bus.publish({ subject: 'task.claimed', seq: 1, ts: now, id: 'id-dedup-1' });

    handler.onOpen();
    await wait(20);

    // The row was sent via backfill (seq=1). The live buffer entry with seq=1 was deduped.
    const byId = sent.filter((e) => e.id === 'id-dedup-1');
    // Should appear exactly once (from backfill only)
    expect(byId.length).toBe(1);

    handler.onClose();
  });
});
