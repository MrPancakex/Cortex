/**
 * Unit tests for sdk/events/durable-write.js
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb, runMigrations, resetDbForTests } from '../../db/index.js';
import { bus } from '../../events/bus.js';
import { writeAndNotify } from '../../events/durable-write.js';

const ROOT = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'cortex-durable-write-'));
const DB_FILE = path.join(ROOT, 'durable.db');
const RECOVERY_FILE = path.join(ROOT, 'event-recovery.jsonl');

function setup() {
  resetDbForTests();
  bus._clearForTests();
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
  if (fs.existsSync(RECOVERY_FILE)) fs.unlinkSync(RECOVERY_FILE);
  process.env.CORTEX_DB_PATH = DB_FILE;
  process.env.CORTEX_EVENT_RECOVERY_FILE = RECOVERY_FILE;
  getDb({ path: DB_FILE });
  runMigrations();
}

beforeEach(setup);

afterAll(() => {
  resetDbForTests();
  delete process.env.CORTEX_DB_PATH;
  delete process.env.CORTEX_EVENT_RECOVERY_FILE;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function makeEnvelope(overrides = {}) {
  return {
    id: randomUUID(),
    subject: 'task.claimed',
    ts: Date.now(),
    source: 'test',
    task_id: 'task-' + randomUUID(),
    session_id: null,
    trace_id: null,
    payload: { assigned_agent: 'nova', claimed_at: Date.now() },
    v: 1,
    ...overrides,
  };
}

describe('writeAndNotify — happy path', () => {
  test('should insert row and return a positive seq', () => {
    const env = makeEnvelope();
    const result = writeAndNotify(env);
    expect(result.duplicate).toBe(false);
    expect(typeof result.seq).toBe('number');
    expect(result.seq).toBeGreaterThan(0);
  });

  test('should fan out to bus subscribers after insert', async () => {
    const received = [];
    const unsub = bus.register('task.claimed', (e) => received.push(e));
    const env = makeEnvelope();
    writeAndNotify(env);
    await bus.drainAll();
    expect(received).toHaveLength(1);
    expect(received[0].id).toBe(env.id);
    unsub();
  });

  test('should include seq on the fanned-out event', async () => {
    const received = [];
    const unsub = bus.register('task.*', (e) => received.push(e));
    const env = makeEnvelope();
    const { seq } = writeAndNotify(env);
    await bus.drainAll();
    expect(received[0].seq).toBe(seq);
    unsub();
  });
});

describe('writeAndNotify — UNIQUE replay', () => {
  test('should return duplicate=true when the same id is inserted twice', () => {
    const env = makeEnvelope();
    writeAndNotify(env);
    const result = writeAndNotify(env);
    expect(result.duplicate).toBe(true);
  });

  test('should return the existing seq on a duplicate', () => {
    const env = makeEnvelope();
    const first = writeAndNotify(env);
    const second = writeAndNotify(env);
    expect(second.seq).toBe(first.seq);
  });

  test('should still fan out to bus on a duplicate', async () => {
    const received = [];
    const env = makeEnvelope();
    writeAndNotify(env);
    const unsub = bus.register('task.claimed', (e) => received.push(e));
    writeAndNotify(env);
    await bus.drainAll();
    expect(received).toHaveLength(1);
    unsub();
  });

  test('should not write to recovery buffer on UNIQUE replay', () => {
    const env = makeEnvelope();
    writeAndNotify(env);
    writeAndNotify(env);
    expect(fs.existsSync(RECOVERY_FILE)).toBe(false);
  });
});

describe('writeAndNotify — non-unique DB error', () => {
  test('should throw and write to recovery buffer when DB is broken', () => {
    const env = makeEnvelope();
    getDb().exec('DROP TABLE events');
    let threw = false;
    try {
      writeAndNotify(env);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(fs.existsSync(RECOVERY_FILE)).toBe(true);
    const line = fs.readFileSync(RECOVERY_FILE, 'utf8').trim();
    const buffered = JSON.parse(line);
    expect(buffered.id).toBe(env.id);
  });

  test('should NOT write to recovery buffer when fromRecovery=true', () => {
    const env = makeEnvelope();
    getDb().exec('DROP TABLE events');
    let threw = false;
    try {
      writeAndNotify(env, { fromRecovery: true });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(fs.existsSync(RECOVERY_FILE)).toBe(false);
  });
});
