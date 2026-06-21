/**
 * Smoke tests for migration 013_runs_table.
 *
 * Slice B Phase 1 — verifies that:
 *   - The `runs` table is created with the exact column set from the
 *     Slice B Phase 1 deliverable spec.
 *   - All 3 required indexes exist (idx_runs_task, idx_runs_provider,
 *     idx_runs_status).
 *   - stmts.insertRun + stmts.getRun round-trip: insert a row, read it back,
 *     assert fields match.
 *   - stmts.updateRunOnExit: flips status, sets ended_at (non-null), populates
 *     cost_usd.
 *   - stmts.listRunsByTask returns the row.
 *   - stmts.countRunsByTask returns 1.
 *
 * Uses a fresh tmpdir DB on every test run — NEVER touches
 * $CORTEX_HOME/state/cortex.db.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDb, runMigrations, resetDbForTests } from '@cortex/sdk/db';
import {
  getTaskStatements,
  resetTaskStatementsForTests,
} from '@cortex/gateway/tasks';

const ROOT = path.join(os.tmpdir(), `cortex-runs-migration-${process.pid}`);

// Reusable seed IDs
const PROJECT_ID = 'proj-runs-test-001';
const TASK_ID    = 'task-runs-test-001';
const RUN_ID     = 'run-00000001-0000-0000-0000-000000000001';

function seedProjectAndTask(db) {
  db.prepare(
    `INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)`,
  ).run(PROJECT_ID, 'Runs Test Project', '/tmp/runs-test');

  db.prepare(
    `INSERT INTO tasks
       (id, project_id, title, description, status, priority, created_by)
     VALUES (?, ?, ?, ?, 'pending', 'medium', 'system')`,
  ).run(TASK_ID, PROJECT_ID, 'Runs test task', '');
}

beforeEach(() => {
  resetTaskStatementsForTests();
  resetDbForTests();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  process.env.CORTEX_DB_PATH = path.join(ROOT, 'runs-migration.db');
  getDb({ path: process.env.CORTEX_DB_PATH });
  runMigrations();
});

afterEach(() => {
  resetTaskStatementsForTests();
  resetDbForTests();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// runs table existence
// ---------------------------------------------------------------------------

test('migration 013 creates the runs table', () => {
  const db = getDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  expect(tables).toContain('runs');
});

// ---------------------------------------------------------------------------
// runs table column shape
// ---------------------------------------------------------------------------

test('migration 013 runs table has all expected columns', () => {
  const db = getDb();
  const cols = db
    .prepare("PRAGMA table_info('runs')")
    .all()
    .map((r) => r.name);

  expect(cols).toContain('run_id');
  expect(cols).toContain('task_id');
  expect(cols).toContain('provider_id');
  expect(cols).toContain('model');
  expect(cols).toContain('status');
  expect(cols).toContain('started_at');
  expect(cols).toContain('ended_at');
  expect(cols).toContain('tokens_in');
  expect(cols).toContain('tokens_out');
  expect(cols).toContain('cost_usd');
  expect(cols).toContain('exit_reason');
  expect(cols).toContain('budget_max_tokens');
  expect(cols).toContain('budget_max_wall_seconds');
  expect(cols).toContain('budget_max_tool_calls');
  // Exact column count (16 columns after migration 015 adds artifact_path).
  expect(cols.length).toBe(16);
});

test('migration 013 runs run_id is the PRIMARY KEY', () => {
  const db = getDb();
  const colInfo = db.prepare("PRAGMA table_info('runs')").all();
  const pk = colInfo.find((c) => c.name === 'run_id');
  expect(pk).toBeDefined();
  expect(pk.pk).toBe(1);
});

test('migration 013 runs status defaults to running', () => {
  const db = getDb();
  const colInfo = db.prepare("PRAGMA table_info('runs')").all();
  const statusCol = colInfo.find((c) => c.name === 'status');
  expect(statusCol).toBeDefined();
  expect(statusCol.dflt_value).toBe("'running'");
  expect(statusCol.notnull).toBe(1);
});

test('migration 015 runs tokens_in and tokens_out are nullable (non-LLM runs have no tokens)', () => {
  const db = getDb();
  const colInfo = db.prepare("PRAGMA table_info('runs')").all();

  const tokensIn  = colInfo.find((c) => c.name === 'tokens_in');
  const tokensOut = colInfo.find((c) => c.name === 'tokens_out');

  // Slice F.1 (migration 015): nullable — tool runs produce no tokens.
  // Pre-existing LLM rows retain their 0 values; new tool rows get NULL.
  expect(tokensIn.notnull).toBe(0);
  expect(tokensOut.notnull).toBe(0);
});

test('migration 015 runs cost_usd is nullable (non-LLM runs have no cost)', () => {
  const db = getDb();
  const colInfo = db.prepare("PRAGMA table_info('runs')").all();
  const costCol = colInfo.find((c) => c.name === 'cost_usd');
  // Slice F.1 (migration 015): nullable — tool runs have no USD cost field.
  expect(costCol.notnull).toBe(0);
});

test('migration 013 runs ended_at is nullable', () => {
  const db = getDb();
  const colInfo = db.prepare("PRAGMA table_info('runs')").all();
  const endedAt = colInfo.find((c) => c.name === 'ended_at');
  expect(endedAt.notnull).toBe(0);
});

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

test('migration 013 creates idx_runs_task index', () => {
  const db = getDb();
  const indexes = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='runs'",
    )
    .all()
    .map((r) => r.name);
  expect(indexes).toContain('idx_runs_task');
});

test('migration 013 creates idx_runs_provider index', () => {
  const db = getDb();
  const indexes = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='runs'",
    )
    .all()
    .map((r) => r.name);
  expect(indexes).toContain('idx_runs_provider');
});

test('migration 013 creates idx_runs_status index', () => {
  const db = getDb();
  const indexes = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='runs'",
    )
    .all()
    .map((r) => r.name);
  expect(indexes).toContain('idx_runs_status');
});

// ---------------------------------------------------------------------------
// schema_migrations tracking
// ---------------------------------------------------------------------------

test('migration 013 lands in schema_migrations', () => {
  const db = getDb();
  const rows = db
    .prepare('SELECT id FROM schema_migrations')
    .all()
    .map((r) => r.id);
  expect(rows).toContain('013_runs_table');
});

// ---------------------------------------------------------------------------
// insertRun / getRun round-trip
// ---------------------------------------------------------------------------

test('insertRun inserts a row and getRun reads it back with correct fields', () => {
  const db = getDb();
  const stmts = getTaskStatements();
  seedProjectAndTask(db);

  stmts.insertRun.run(
    RUN_ID,
    TASK_ID,
    'claude-code',          // provider_id
    'claude-sonnet-4-6',    // model
    'running',              // status
    50000,                  // budget_max_tokens
    300,                    // budget_max_wall_seconds
    20,                     // budget_max_tool_calls
  );

  const row = stmts.getRun.get(RUN_ID);
  expect(row).toBeDefined();
  expect(row.run_id).toBe(RUN_ID);
  expect(row.task_id).toBe(TASK_ID);
  expect(row.provider_id).toBe('claude-code');
  expect(row.model).toBe('claude-sonnet-4-6');
  expect(row.status).toBe('running');
  // Slice F.1 (migration 015): tokens_in/out and cost_usd are nullable.
  // insertRun does not bind them — new LLM runs start as NULL, not 0.
  // The handleSubagentExit path (updateRunOnExit) writes the real values.
  expect(row.tokens_in).toBeNull();
  expect(row.tokens_out).toBeNull();
  expect(row.cost_usd).toBeNull();
  expect(row.ended_at).toBeNull();
  expect(row.budget_max_tokens).toBe(50000);
  expect(row.budget_max_wall_seconds).toBe(300);
  expect(row.budget_max_tool_calls).toBe(20);
  // started_at is set by datetime('now') — non-empty string
  expect(typeof row.started_at).toBe('string');
  expect(row.started_at.length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// updateRunOnExit — status flipped, ended_at set, cost_usd populated
// ---------------------------------------------------------------------------

test('updateRunOnExit flips status, sets ended_at, and populates cost_usd', () => {
  const db = getDb();
  const stmts = getTaskStatements();
  seedProjectAndTask(db);

  stmts.insertRun.run(RUN_ID, TASK_ID, 'codex', 'gpt-4o', 'running', null, null, null);

  stmts.updateRunOnExit.run(
    'completed',   // status
    12000,         // tokens_in
    3400,          // tokens_out
    0.0156,        // cost_usd
    'task_complete', // exit_reason
    RUN_ID,        // WHERE run_id = ?  (must be LAST)
  );

  const row = stmts.getRun.get(RUN_ID);
  expect(row.status).toBe('completed');
  expect(row.ended_at).not.toBeNull();
  expect(typeof row.ended_at).toBe('string');
  expect(row.ended_at.length).toBeGreaterThan(0);
  expect(row.tokens_in).toBe(12000);
  expect(row.tokens_out).toBe(3400);
  expect(row.cost_usd).toBeCloseTo(0.0156, 6);
  expect(row.exit_reason).toBe('task_complete');
});

// ---------------------------------------------------------------------------
// listRunsByTask
// ---------------------------------------------------------------------------

test('listRunsByTask returns the inserted run row', () => {
  const db = getDb();
  const stmts = getTaskStatements();
  seedProjectAndTask(db);

  stmts.insertRun.run(RUN_ID, TASK_ID, 'claude-code', 'claude-sonnet-4-6', 'running', null, null, null);

  const rows = stmts.listRunsByTask.all(TASK_ID);
  expect(rows.length).toBe(1);
  expect(rows[0].run_id).toBe(RUN_ID);
});

// ---------------------------------------------------------------------------
// countRunsByTask
// ---------------------------------------------------------------------------

test('countRunsByTask returns 1 after a single insertRun', () => {
  const db = getDb();
  const stmts = getTaskStatements();
  seedProjectAndTask(db);

  stmts.insertRun.run(RUN_ID, TASK_ID, 'claude-code', 'claude-sonnet-4-6', 'running', null, null, null);

  const result = stmts.countRunsByTask.get(TASK_ID);
  expect(result.n).toBe(1);
});
