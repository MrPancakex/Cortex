import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { getDb, runMigrations, resetDbForTests } from '../db/index.js';
import { emit } from '../events/index.js';
import { runVacuumOnce } from '../events/vacuum.js';
import { archiveRows, archiveEnabled, archiveDir } from '../events/archive.js';
import { bus } from '../events/bus.js';

const ROOT = path.join(os.tmpdir(), `cortex-events-vacuum-${process.pid}`);
const DB_FILE = path.join(ROOT, 'vacuum.db');
const ARCHIVE_DIR = path.join(ROOT, 'archive');

beforeEach(() => {
  resetDbForTests();
  bus._clearForTests();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  process.env.CORTEX_DB_PATH = DB_FILE;
  delete process.env.CORTEX_EVENT_ARCHIVE;
  delete process.env.CORTEX_EVENT_ARCHIVE_DIR;
  getDb({ path: DB_FILE });
  runMigrations();
});

afterAll(() => {
  resetDbForTests();
  delete process.env.CORTEX_DB_PATH;
  delete process.env.CORTEX_EVENT_ARCHIVE;
  delete process.env.CORTEX_EVENT_ARCHIVE_DIR;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function backdate(db, seq, olderByMs) {
  const row = db.prepare('SELECT ts FROM events WHERE seq = ?').get(seq);
  const newTs = Number(row.ts) - olderByMs;
  db.prepare('UPDATE events SET ts = ? WHERE seq = ?').run(newTs, seq);
}

describe('runVacuumOnce', () => {
  test('deletes rows older than retentionMs and leaves younger ones', () => {
    const db = getDb();
    const old1 = emit('task.claimed', {
      task_id: '11111111-2222-4333-8444-555555555555',
      assigned_agent: 'a',
      claimed_at: 0,
    });
    const old2 = emit('task.claimed', {
      task_id: '22222222-3333-4444-8555-666666666666',
      assigned_agent: 'a',
      claimed_at: 0,
    });
    emit('task.claimed', {
      task_id: '33333333-4444-4444-8555-777777777777',
      assigned_agent: 'a',
      claimed_at: 0,
    });
    // Push old1 + old2 past the retention cutoff.
    backdate(db, old1.seq, 60 * 60_000);
    backdate(db, old2.seq, 60 * 60_000);

    const result = runVacuumOnce({ retentionMs: 30 * 60_000 });
    expect(result.deleted).toBe(2);
    expect(result.archived).toBe(0);
    const remaining = db.prepare('SELECT count(*) c FROM events').get().c;
    expect(Number(remaining)).toBe(1);
  });

  test('is a no-op when nothing is older than the cutoff', () => {
    emit('task.claimed', {
      task_id: '11111111-2222-4333-8444-555555555555',
      assigned_agent: 'a',
      claimed_at: 0,
    });
    const result = runVacuumOnce({ retentionMs: 30 * 24 * 60 * 60_000 });
    expect(result).toEqual({ archived: 0, deleted: 0 });
  });

  test('preserves a younger-ts row sitting in a seq gap between two old-ts rows', () => {
    // Regression for review reject #1 (2026-04-22): vacuum DELETE used to
    // be `seq BETWEEN min(selected) AND max(selected)`, which would
    // catch YOUNGER-ts rows interleaved between two OLDER-ts rows when
    // emits land with out-of-order timestamps.
    const db = getDb();
    const a = emit('task.claimed', {
      task_id: '11111111-2222-4333-8444-555555555555',
      assigned_agent: 'a',
      claimed_at: 0,
    });
    const b = emit('task.claimed', {
      task_id: '22222222-3333-4444-8555-666666666666',
      assigned_agent: 'a',
      claimed_at: 0,
    });
    const c = emit('task.claimed', {
      task_id: '33333333-4444-4444-8555-777777777777',
      assigned_agent: 'a',
      claimed_at: 0,
    });
    // Backdate a and c past the retention cutoff, but leave b young.
    // The selected set for vacuum is {a, c}; a naive BETWEEN(a.seq, c.seq)
    // would sweep b too.
    backdate(db, a.seq, 60 * 60_000);
    backdate(db, c.seq, 60 * 60_000);

    const result = runVacuumOnce({ retentionMs: 30 * 60_000 });
    expect(result.deleted).toBe(2);

    const surviving = db
      .prepare('SELECT seq FROM events ORDER BY seq ASC')
      .all()
      .map((r) => Number(r.seq));
    expect(surviving).toEqual([b.seq]);
  });
});

describe('archiveRows + CORTEX_EVENT_ARCHIVE toggle', () => {
  test('is disabled unless CORTEX_EVENT_ARCHIVE is set', () => {
    expect(archiveEnabled()).toBe(false);
    expect(archiveRows([{ seq: 1 }])).toBeNull();
  });

  test('gzips a JSONL stream and returns the file path when enabled', () => {
    process.env.CORTEX_EVENT_ARCHIVE = '1';
    process.env.CORTEX_EVENT_ARCHIVE_DIR = ARCHIVE_DIR;
    const rows = [
      { seq: 1, subject: 'task.claimed' },
      { seq: 2, subject: 'task.approved' },
    ];
    const file = archiveRows(rows);
    expect(file).not.toBeNull();
    expect(file.startsWith(ARCHIVE_DIR)).toBe(true);
    const raw = fs.readFileSync(file);
    const text = zlib.gunzipSync(raw).toString('utf8');
    const lines = text.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ seq: 1, subject: 'task.claimed' });
  });

  test('returns null for an empty rows array', () => {
    process.env.CORTEX_EVENT_ARCHIVE = '1';
    expect(archiveRows([])).toBeNull();
  });
});

describe('archiveDir precedence', () => {
  test('honors CORTEX_EVENT_ARCHIVE_DIR override', () => {
    process.env.CORTEX_EVENT_ARCHIVE_DIR = '/tmp/custom-archive';
    expect(archiveDir()).toBe('/tmp/custom-archive');
  });
});
