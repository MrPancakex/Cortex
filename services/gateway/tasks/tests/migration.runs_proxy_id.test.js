/**
 * Smoke tests for migration 014_runs_proxy_subagent_id.
 *
 * Slice C Phase 1 — verifies that:
 *   1. After applying all migrations, runs.proxy_subagent_id column exists
 *      (PRAGMA table_info).
 *   2. idx_runs_proxy_subagent index exists (sqlite_master).
 *   3. Insert a subagents row + runs row with proxy_subagent_id set;
 *      SELECT returns the value.
 *   4. Insert a runs row with proxy_subagent_id = NULL (back-compat for
 *      pre-Slice-C runs); SELECT returns NULL.
 *   5. Insert a runs row referencing a non-existent subagents.id while FKs
 *      are ON (connection.js:applyPragmas sets PRAGMA foreign_keys = ON).
 *      Asserts the INSERT throws a FK violation.
 *   6. CASCADE / NO ACTION semantics: DELETE the parent subagents row while a
 *      child runs row still references it. With NO ACTION + FKs ON the DELETE
 *      throws; the runs row is untouched.
 *
 * FK note: connection.js:applyPragmas applies PRAGMA foreign_keys = ON
 * unconditionally. Tests run with FKs enabled; FK violations throw in bun:sqlite.
 * Production behaviour matches the test behaviour.
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

const ROOT = path.join(os.tmpdir(), `cortex-runs-proxy-id-migration-${process.pid}`);

// Reusable seed IDs
const PROJECT_ID   = 'proj-proxy-id-test-001';
const TASK_ID      = 'task-proxy-id-test-001';
const RUN_ID       = 'run-proxy-id-00000001-0000-0000-0000-000000000001';
const RUN_ID_NULL  = 'run-proxy-id-00000002-0000-0000-0000-000000000002';
const SUBAGENT_ID  = 'subagent-proxy-id-test-001';

/**
 * Seed a minimal project + task row so that insertRun's task_id FK resolves.
 */
function seedProjectAndTask(db) {
  db.prepare(
    `INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)`,
  ).run(PROJECT_ID, 'Proxy ID Test Project', '/tmp/proxy-id-test');

  db.prepare(
    `INSERT INTO tasks
       (id, project_id, title, description, status, priority, created_by)
     VALUES (?, ?, ?, ?, 'pending', 'medium', 'system')`,
  ).run(TASK_ID, PROJECT_ID, 'Proxy ID test task', '');
}

/**
 * Seed a minimal subagents row. Required columns from migration 005:
 *   id (TEXT PK), profile (TEXT NOT NULL), created_at (INTEGER NOT NULL).
 * state defaults to 'spawning'; everything else is nullable.
 * created_at uses Date.now() millis, matching subagent-spawn.js:106 convention.
 */
function seedSubagent(db, id) {
  db.prepare(
    `INSERT INTO subagents (id, profile, created_at) VALUES (?, ?, ?)`,
  ).run(id, 'claude', Date.now());
}

beforeEach(() => {
  resetTaskStatementsForTests();
  resetDbForTests();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  process.env.CORTEX_DB_PATH = path.join(ROOT, 'proxy-id-migration.db');
  getDb({ path: process.env.CORTEX_DB_PATH });
  runMigrations();
});

afterEach(() => {
  resetTaskStatementsForTests();
  resetDbForTests();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Column existence
// ---------------------------------------------------------------------------

test('migration 014 adds proxy_subagent_id column to runs', () => {
  const db = getDb();
  const cols = db
    .prepare("PRAGMA table_info('runs')")
    .all()
    .map((r) => r.name);
  expect(cols).toContain('proxy_subagent_id');
});

test('migration 014 proxy_subagent_id is nullable (no NOT NULL constraint)', () => {
  const db = getDb();
  const colInfo = db.prepare("PRAGMA table_info('runs')").all();
  const col = colInfo.find((c) => c.name === 'proxy_subagent_id');
  expect(col).toBeDefined();
  expect(col.notnull).toBe(0);
});

// ---------------------------------------------------------------------------
// 2. Index existence
// ---------------------------------------------------------------------------

test('migration 014 creates idx_runs_proxy_subagent index', () => {
  const db = getDb();
  const indexes = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='runs'",
    )
    .all()
    .map((r) => r.name);
  expect(indexes).toContain('idx_runs_proxy_subagent');
});

// ---------------------------------------------------------------------------
// 3. FK join: insert runs row with valid proxy_subagent_id, verify SELECT
// ---------------------------------------------------------------------------

test('runs row with valid proxy_subagent_id is stored and returned', () => {
  const db = getDb();
  const stmts = getTaskStatements();
  seedProjectAndTask(db);
  seedSubagent(db, SUBAGENT_ID);

  // insertRun does not include proxy_subagent_id — it's set separately after
  // spawn returns the id (per Slice C Phase 4 protocol). Insert via raw SQL here
  // because stmts.insertRun predates migration 014.
  stmts.insertRun.run(
    RUN_ID,
    TASK_ID,
    'claude-code',
    'claude-sonnet-4-6',
    'running',
    null,
    null,
    null,
  );
  db.prepare(
    `UPDATE runs SET proxy_subagent_id = ? WHERE run_id = ?`,
  ).run(SUBAGENT_ID, RUN_ID);

  const row = stmts.getRun.get(RUN_ID);
  expect(row).toBeDefined();
  expect(row.proxy_subagent_id).toBe(SUBAGENT_ID);
});

// ---------------------------------------------------------------------------
// 4. Back-compat: runs row with proxy_subagent_id = NULL (pre-Slice-C)
// ---------------------------------------------------------------------------

test('runs row with proxy_subagent_id = NULL is stored and returned (back-compat)', () => {
  const db = getDb();
  const stmts = getTaskStatements();
  seedProjectAndTask(db);

  stmts.insertRun.run(
    RUN_ID_NULL,
    TASK_ID,
    'claude-code',
    'claude-sonnet-4-6',
    'running',
    null,
    null,
    null,
  );

  const row = stmts.getRun.get(RUN_ID_NULL);
  expect(row).toBeDefined();
  // proxy_subagent_id should be NULL for pre-Slice-C historical runs
  expect(row.proxy_subagent_id).toBeNull();
});

// ---------------------------------------------------------------------------
// 5. FK violation: insert runs row referencing non-existent subagents.id
//
// FKs are ON (connection.js:applyPragmas: PRAGMA foreign_keys = ON).
// Production matches this behaviour.
// ---------------------------------------------------------------------------

test('inserting runs row with non-existent proxy_subagent_id throws FK violation', () => {
  const db = getDb();
  const stmts = getTaskStatements();
  seedProjectAndTask(db);

  stmts.insertRun.run(
    RUN_ID,
    TASK_ID,
    'claude-code',
    'claude-sonnet-4-6',
    'running',
    null,
    null,
    null,
  );

  expect(() => {
    db.prepare(
      `UPDATE runs SET proxy_subagent_id = ? WHERE run_id = ?`,
    ).run('subagent-does-not-exist', RUN_ID);
  }).toThrow();
});

// ---------------------------------------------------------------------------
// 6. NO ACTION cascade: DELETE parent subagents row referenced by runs row
//
// The FK is declared without ON DELETE clause, which means SQLite uses the
// default NO ACTION. With PRAGMA foreign_keys = ON, this causes the DELETE
// to throw a FK constraint error rather than silently nulling or cascading.
//
// Semantics chosen: NO ACTION (not CASCADE, not SET NULL) — because SIGTERM
// decisions for close routes should be explicit; an accidental subagents
// row deletion must NOT silently orphan the runs reference. If the proxy
// process record needs to be removed, the runs row must be updated first.
//
// This matches the plan's "C6 locked decision" (runs.proxy_subagent_id FK
// to subagents.id) with no ON DELETE clause.
// ---------------------------------------------------------------------------

test('DELETE parent subagents row with referencing runs row throws NO ACTION error', () => {
  const db = getDb();
  const stmts = getTaskStatements();
  seedProjectAndTask(db);
  seedSubagent(db, SUBAGENT_ID);

  stmts.insertRun.run(
    RUN_ID,
    TASK_ID,
    'claude-code',
    'claude-sonnet-4-6',
    'running',
    null,
    null,
    null,
  );
  db.prepare(
    `UPDATE runs SET proxy_subagent_id = ? WHERE run_id = ?`,
  ).run(SUBAGENT_ID, RUN_ID);

  // With FKs ON and NO ACTION, this DELETE must throw because runs still
  // references this subagents row.
  expect(() => {
    db.prepare(`DELETE FROM subagents WHERE id = ?`).run(SUBAGENT_ID);
  }).toThrow();

  // The runs row must be untouched — proxy_subagent_id still points at the
  // subagents row (the DELETE was rolled back by the constraint violation).
  const row = stmts.getRun.get(RUN_ID);
  expect(row).toBeDefined();
  expect(row.proxy_subagent_id).toBe(SUBAGENT_ID);
});

// ---------------------------------------------------------------------------
// schema_migrations tracking
// ---------------------------------------------------------------------------

test('migration 014 lands in schema_migrations', () => {
  const db = getDb();
  const rows = db
    .prepare('SELECT id FROM schema_migrations')
    .all()
    .map((r) => r.id);
  expect(rows).toContain('014_runs_proxy_subagent_id');
});
