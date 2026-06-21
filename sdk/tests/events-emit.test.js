import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDb, runMigrations, resetDbForTests } from '../db/index.js';
import { emit, subscribe, getCursor } from '../events/index.js';
import { bus } from '../events/bus.js';

const ROOT = path.join(os.tmpdir(), `cortex-events-emit-${process.pid}`);
const DB_FILE = path.join(ROOT, 'events-test.db');

beforeEach(() => {
  resetDbForTests();
  // Clear the module-level bus so a leaked subscription from a prior
  // test cannot receive events from this test's emits.
  bus._clearForTests();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  process.env.CORTEX_DB_PATH = DB_FILE;
  // Initialize the db + apply migrations so the events table exists.
  getDb({ path: DB_FILE });
  runMigrations();
});

afterAll(() => {
  resetDbForTests();
  delete process.env.CORTEX_DB_PATH;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function wait(ms = 10) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('emit end-to-end', () => {
  test('persists a row and returns a monotonic seq', () => {
    const r1 = emit('task.claimed', {
      task_id: '11111111-2222-4333-8444-555555555555',
      assigned_agent: 'nova-4',
      claimed_at: 1700000000000,
    });
    const r2 = emit('task.claimed', {
      task_id: '22222222-3333-4444-8555-666666666666',
      assigned_agent: 'nova-4',
      claimed_at: 1700000000001,
    });
    expect(r1.seq).toBeGreaterThan(0);
    expect(r2.seq).toBeGreaterThan(r1.seq);
    expect(r1.duplicate).toBe(false);
    expect(r2.duplicate).toBe(false);
  });

  test('rejects an emit with a payload that fails schema validation', () => {
    expect(() => emit('task.claimed', { nope: true })).toThrow(/rejected.*payload_invalid/);
  });

  test('rejects an emit with a subject not in the taxonomy', () => {
    expect(() => emit('made.up', {})).toThrow(/rejected.*unknown_subject/);
  });

  test('fans out to an in-process subscriber', async () => {
    const seen = [];
    const off = subscribe('task.*', (event) => { seen.push(event.subject); });
    emit('task.claimed', {
      task_id: '11111111-2222-4333-8444-555555555555',
      assigned_agent: 'nova-4',
      claimed_at: 0,
    });
    await wait(20);
    off();
    expect(seen).toContain('task.claimed');
  });
});

describe('getCursor', () => {
  test('returns rows strictly greater than sinceSeq', () => {
    const a = emit('task.claimed', {
      task_id: '11111111-2222-4333-8444-555555555555',
      assigned_agent: 'nova-4',
      claimed_at: 0,
    });
    emit('task.claimed', {
      task_id: '22222222-3333-4444-8555-666666666666',
      assigned_agent: 'nova-4',
      claimed_at: 1,
    });
    const rows = getCursor('task.*', a.seq);
    expect(rows).toHaveLength(1);
    expect(rows[0].seq).toBeGreaterThan(a.seq);
    expect(rows[0].payload.assigned_agent).toBe('nova-4');
  });

  test('honors the subject glob', () => {
    emit('task.claimed', {
      task_id: '11111111-2222-4333-8444-555555555555',
      assigned_agent: 'nova-4',
      claimed_at: 0,
    });
    emit('agent.stale', {
      agent_id: 'nova-4',
      last_heartbeat_at: 0,
      detected_at: 1,
    });
    expect(getCursor('task.*', 0).every((r) => r.subject.startsWith('task.'))).toBe(true);
    expect(getCursor('agent.stale', 0).every((r) => r.subject === 'agent.stale')).toBe(true);
    expect(getCursor('*', 0).length).toBeGreaterThanOrEqual(2);
  });

  test('hard-caps returned rows at the limit argument', () => {
    for (let i = 0; i < 5; i += 1) {
      emit('task.claimed', {
        task_id: '11111111-2222-4333-8444-55555555555' + i,
        assigned_agent: 'nova-4',
        claimed_at: i,
      });
    }
    expect(getCursor('*', 0, 2)).toHaveLength(2);
  });

  test('rejects invalid sinceSeq', () => {
    expect(() => getCursor('*', -1)).toThrow(/non-negative/);
    expect(() => getCursor('*', Number.NaN)).toThrow(/non-negative/);
  });
});
