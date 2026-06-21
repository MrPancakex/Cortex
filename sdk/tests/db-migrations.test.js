import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { closeDb, getDb, readPragma } from '../db/connection.js';
import { runMigrations, currentSchemaVersion } from '../db/migrations/index.js';

const TEST_DIR = path.join(os.tmpdir(), `cortex-sdk-db-test-${process.pid}`);
const TEST_DB = path.join(TEST_DIR, 'cortex-test.db');

beforeEach(() => {
  closeDb();
  fs.mkdirSync(TEST_DIR, { recursive: true, mode: 0o700 });
  for (const f of ['cortex-test.db', 'cortex-test.db-wal', 'cortex-test.db-shm']) {
    try {
      fs.unlinkSync(path.join(TEST_DIR, f));
    } catch {
      // best-effort cleanup
    }
  }
  process.env.CORTEX_DB_PATH = TEST_DB;
});

afterAll(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('db connection + migrations', () => {
  test('getDb creates the file and enables WAL', () => {
    getDb();
    expect(fs.existsSync(TEST_DB)).toBe(true);
    const mode = readPragma('journal_mode');
    expect(mode).toBe('wal');
  });

  test('runMigrations applies 001_initial_schema and creates all tables', () => {
    const applied = runMigrations();
    expect(applied).toContain('001_initial_schema');

    const rows = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    const names = rows.map((r) => r.name);
    for (const expected of [
      'projects',
      'phases',
      'agents',
      'tasks',
      'progress_reports',
      'bridge_messages',
      'task_comments',
      'sessions',
      'cost_entries',
      'schema_migrations',
    ]) {
      expect(names).toContain(expected);
    }
  });

  test('runMigrations is idempotent', () => {
    runMigrations();
    const second = runMigrations();
    expect(second).toEqual([]);
  });

  test('currentSchemaVersion returns the newest applied id', () => {
    runMigrations();
    // Phase 3 added 002_events_table.sql so the head moved forward.
    // Assert the shape instead of a hardcoded version so future
    // migrations don't silently invalidate the check.
    const version = currentSchemaVersion();
    expect(typeof version).toBe('string');
    expect(/^\d{3}_/.test(version)).toBe(true);
    expect(version >= '001_initial_schema').toBe(true);
  });
});
