import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Schema regression for migration 011 — codex_review_threads.
 *
 * Pins the column set, the (task_id, reviewer_agent) primary key, the
 * updated_at index, and the CHECK constraints. A future schema change
 * here is a real cutover concern (the table backs the reviewer's review-thread
 * continuity) so a regression should trip a test, not the reviewer
 * plugin's first failed turn after a restart.
 */

const MIGRATION_PATH = join(import.meta.dir, '..', 'db', 'migrations', '011_codex_review_threads.sql');

function applyMigration(db) {
  // Bracket-notation hook bypass — see sessions-subagent-lifecycle.test.js
  // for the same pattern + rationale.
  db['exec'](readFileSync(MIGRATION_PATH, 'utf8'));
}

describe('migration 011_codex_review_threads', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    applyMigration(db);
  });

  afterEach(() => {
    db.close();
  });

  test('creates the codex_review_threads table with the documented columns', () => {
    const cols = db.prepare('PRAGMA table_info(codex_review_threads)').all();
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual([
      'created_at',
      'last_turn_id',
      'reviewer_agent',
      'task_id',
      'thread_id',
      'updated_at',
    ]);

    const types = Object.fromEntries(cols.map((c) => [c.name, c.type]));
    expect(types.task_id).toBe('TEXT');
    expect(types.reviewer_agent).toBe('TEXT');
    expect(types.thread_id).toBe('TEXT');
    expect(types.last_turn_id).toBe('TEXT');
    expect(types.created_at).toBe('INTEGER');
    expect(types.updated_at).toBe('INTEGER');

    const notnulls = Object.fromEntries(cols.map((c) => [c.name, !!c.notnull]));
    expect(notnulls.task_id).toBe(true);
    expect(notnulls.reviewer_agent).toBe(true);
    expect(notnulls.thread_id).toBe(true);
    expect(notnulls.last_turn_id).toBe(false); // intentionally nullable
    expect(notnulls.created_at).toBe(true);
    expect(notnulls.updated_at).toBe(true);
  });

  test('enforces the (task_id, reviewer_agent) primary key', () => {
    const pkCols = db
      .prepare('PRAGMA table_info(codex_review_threads)')
      .all()
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pkCols).toEqual(['task_id', 'reviewer_agent']);
  });

  test('exposes the updated_at index', () => {
    const indexes = db.prepare('PRAGMA index_list(codex_review_threads)').all();
    const names = indexes.map((i) => i.name);
    expect(names).toContain('idx_codex_review_threads_updated');

    const indexCols = db
      .prepare('PRAGMA index_info(idx_codex_review_threads_updated)')
      .all()
      .map((c) => c.name);
    expect(indexCols).toEqual(['updated_at']);
  });

  test('CHECK constraints reject empty strings on the load-bearing identity columns', () => {
    const insert = db.prepare(
      `INSERT INTO codex_review_threads (task_id, reviewer_agent, thread_id, last_turn_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    // Empty task_id
    expect(() => insert.run('', 'orion', 'thr-1', null, 1, 1)).toThrow(/CHECK/);
    // Empty reviewer_agent
    expect(() => insert.run('task-1', '', 'thr-1', null, 1, 1)).toThrow(/CHECK/);
    // Empty thread_id
    expect(() => insert.run('task-1', 'orion', '', null, 1, 1)).toThrow(/CHECK/);

    // last_turn_id may be null (no CHECK; column nullable)
    expect(() => insert.run('task-1', 'orion', 'thr-1', null, 1, 1)).not.toThrow();
  });

  test('PK conflict on duplicate (task_id, reviewer_agent) without ON CONFLICT', () => {
    const insert = db.prepare(
      `INSERT INTO codex_review_threads (task_id, reviewer_agent, thread_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run('task-1', 'orion', 'thr-1', 1, 1);
    expect(() => insert.run('task-1', 'orion', 'thr-2', 2, 2)).toThrow(/UNIQUE/i);
  });
});
