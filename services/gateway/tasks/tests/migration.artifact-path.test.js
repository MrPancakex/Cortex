/**
 * Tests for migration 015_runs_artifact_path.
 *
 * Slice F.1 (2026-05-25) — verifies:
 *   1. All migrations 1–15 apply cleanly; artifact_path column exists;
 *      tokens_in/out + cost_usd are nullable (notnull=0).
 *   2. Insert with NULL tokens/cost/artifact_path succeeds.
 *   3. Insert with all fields populated succeeds.
 *   4. artifact_path as a single string path round-trips correctly.
 *   5. artifact_path as a JSON-array string round-trips correctly
 *      (column is TEXT; consumer parses).
 *   6. UPDATE to set artifact_path on an existing row works.
 *   7. idx_runs_artifact partial index exists.
 *   8. Pre-existing LLM-run-style rows (tokens_in=0) are preserved.
 *
 * Uses a fresh tmpdir DB on every test — NEVER touches
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

const ROOT = path.join(os.tmpdir(), `cortex-f1-migration-${process.pid}`);

// Stable seed IDs
const PROJECT_ID = 'proj-f1-test-001';
const TASK_ID    = 'task-f1-test-001';
const RUN_LLM    = 'run-f1-llm-0001-0000-0000-000000000001';
const RUN_TOOL   = 'run-f1-tool-0001-0000-0000-000000000002';
const RUN_MULTI  = 'run-f1-multi-0001-0000-0000-000000000003';
const RUN_LEGACY = 'run-f1-legcy-0001-0000-0000-000000000004';

function seedProjectAndTask(db) {
  db.prepare(
    `INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)`,
  ).run(PROJECT_ID, 'F.1 Test Project', '/tmp/f1-test');

  db.prepare(
    `INSERT INTO tasks
       (id, project_id, title, description, status, priority, created_by)
     VALUES (?, ?, ?, ?, 'pending', 'medium', 'system')`,
  ).run(TASK_ID, PROJECT_ID, 'F.1 artifact path test task', '');
}

beforeEach(() => {
  resetTaskStatementsForTests();
  resetDbForTests();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  process.env.CORTEX_DB_PATH = path.join(ROOT, 'f1-migration.db');
  getDb({ path: process.env.CORTEX_DB_PATH });
  runMigrations();
});

afterEach(() => {
  resetTaskStatementsForTests();
  resetDbForTests();
  delete process.env.CORTEX_DB_PATH;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1: migration 015 applied; artifact_path column exists; LLM fields nullable
// ---------------------------------------------------------------------------

test('migration 015 creates artifact_path column on runs', () => {
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info('runs')").all().map((r) => r.name);
  expect(cols).toContain('artifact_path');
});

test('migration 015 makes tokens_in nullable (notnull=0)', () => {
  const db = getDb();
  const col = db.prepare("PRAGMA table_info('runs')").all().find((r) => r.name === 'tokens_in');
  expect(col).toBeDefined();
  expect(col.notnull).toBe(0);
});

test('migration 015 makes tokens_out nullable (notnull=0)', () => {
  const db = getDb();
  const col = db.prepare("PRAGMA table_info('runs')").all().find((r) => r.name === 'tokens_out');
  expect(col).toBeDefined();
  expect(col.notnull).toBe(0);
});

test('migration 015 makes cost_usd nullable (notnull=0)', () => {
  const db = getDb();
  const col = db.prepare("PRAGMA table_info('runs')").all().find((r) => r.name === 'cost_usd');
  expect(col).toBeDefined();
  expect(col.notnull).toBe(0);
});

test('migration 015 lands in schema_migrations', () => {
  const db = getDb();
  const rows = db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id);
  expect(rows).toContain('015_runs_artifact_path');
});

// ---------------------------------------------------------------------------
// Test 2: insert with all nullable LLM fields and artifact_path as NULL
// ---------------------------------------------------------------------------

test('insert run with NULL tokens, cost, and artifact_path succeeds', () => {
  const db = getDb();
  seedProjectAndTask(db);

  db.prepare(`
    INSERT INTO runs
      (run_id, task_id, provider_id, model, status,
       tokens_in, tokens_out, cost_usd, artifact_path)
    VALUES (?, ?, ?, ?, 'running', NULL, NULL, NULL, NULL)
  `).run(RUN_TOOL, TASK_ID, 'blender', 'blender-4.0');

  const row = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(RUN_TOOL);
  expect(row).toBeDefined();
  expect(row.tokens_in).toBeNull();
  expect(row.tokens_out).toBeNull();
  expect(row.cost_usd).toBeNull();
  expect(row.artifact_path).toBeNull();
});

// ---------------------------------------------------------------------------
// Test 3: insert with all fields populated
// ---------------------------------------------------------------------------

test('insert run with all fields populated succeeds', () => {
  const db = getDb();
  seedProjectAndTask(db);

  db.prepare(`
    INSERT INTO runs
      (run_id, task_id, provider_id, model, status,
       tokens_in, tokens_out, cost_usd, artifact_path)
    VALUES (?, ?, ?, ?, 'completed', 12000, 3400, 0.0156, ?)
  `).run(RUN_LLM, TASK_ID, 'claude-code', 'claude-sonnet-4-6',
         '/opt/renders/scene_001.png');

  const row = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(RUN_LLM);
  expect(row).toBeDefined();
  expect(row.tokens_in).toBe(12000);
  expect(row.tokens_out).toBe(3400);
  expect(row.cost_usd).toBeCloseTo(0.0156, 6);
  expect(row.artifact_path).toBe('/opt/renders/scene_001.png');
});

// ---------------------------------------------------------------------------
// Test 4: artifact_path as a single string round-trips
// ---------------------------------------------------------------------------

test('artifact_path as a single path string round-trips correctly', () => {
  const db = getDb();
  seedProjectAndTask(db);

  const singlePath = '/renders/output_001.png';

  db.prepare(`
    INSERT INTO runs
      (run_id, task_id, provider_id, model, status, artifact_path)
    VALUES (?, ?, ?, ?, 'completed', ?)
  `).run(RUN_TOOL, TASK_ID, 'render-tool', 'model-x', singlePath);

  const row = db.prepare('SELECT artifact_path FROM runs WHERE run_id = ?').get(RUN_TOOL);
  expect(row.artifact_path).toBe(singlePath);
});

// ---------------------------------------------------------------------------
// Test 5: artifact_path as a JSON-array string round-trips
// ---------------------------------------------------------------------------

test('artifact_path as a JSON array string round-trips correctly', () => {
  const db = getDb();
  seedProjectAndTask(db);

  const arrayPath = '["path1/render.png","path2/render.png"]';

  db.prepare(`
    INSERT INTO runs
      (run_id, task_id, provider_id, model, status, artifact_path)
    VALUES (?, ?, ?, ?, 'completed', ?)
  `).run(RUN_MULTI, TASK_ID, 'render-tool', 'model-x', arrayPath);

  const row = db.prepare('SELECT artifact_path FROM runs WHERE run_id = ?').get(RUN_MULTI);
  expect(row.artifact_path).toBe(arrayPath);
  // Consumer parses: the stored TEXT is valid JSON
  const parsed = JSON.parse(row.artifact_path);
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed).toHaveLength(2);
  expect(parsed[0]).toBe('path1/render.png');
});

// ---------------------------------------------------------------------------
// Test 6: UPDATE to set artifact_path on existing row works
// ---------------------------------------------------------------------------

test('updateRunArtifactPath statement sets artifact_path on existing row', () => {
  const db = getDb();
  const stmts = getTaskStatements();
  seedProjectAndTask(db);

  // Insert a tool run without artifact_path
  db.prepare(`
    INSERT INTO runs (run_id, task_id, provider_id, model, status)
    VALUES (?, ?, ?, ?, 'running')
  `).run(RUN_TOOL, TASK_ID, 'blender', 'blender-4.0');

  expect(db.prepare('SELECT artifact_path FROM runs WHERE run_id = ?').get(RUN_TOOL).artifact_path).toBeNull();

  // Apply the new statement
  stmts.updateRunArtifactPath.run('/renders/final.out', RUN_TOOL);

  const updated = db.prepare('SELECT artifact_path FROM runs WHERE run_id = ?').get(RUN_TOOL);
  expect(updated.artifact_path).toBe('/renders/final.out');
});

// ---------------------------------------------------------------------------
// Test 7: idx_runs_artifact partial index exists
// ---------------------------------------------------------------------------

test('idx_runs_artifact partial index is present on the runs table', () => {
  const db = getDb();
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='runs'")
    .all()
    .map((r) => r.name);
  expect(indexes).toContain('idx_runs_artifact');
});

// ---------------------------------------------------------------------------
// Test 8: pre-existing rows with tokens_in=0 are preserved (backwards compat)
// ---------------------------------------------------------------------------

test('pre-existing LLM-run rows with tokens_in=0 are preserved after migration', () => {
  const db = getDb();
  seedProjectAndTask(db);

  // Simulate a pre-migration LLM row that had NOT NULL DEFAULT 0.
  // After migration 015 the column is nullable but old 0 values survive.
  db.prepare(`
    INSERT INTO runs
      (run_id, task_id, provider_id, model, status,
       tokens_in, tokens_out, cost_usd)
    VALUES (?, ?, ?, ?, 'completed', 0, 0, 0)
  `).run(RUN_LEGACY, TASK_ID, 'claude-code', 'claude-sonnet-4-6');

  const row = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(RUN_LEGACY);
  expect(row.tokens_in).toBe(0);
  expect(row.tokens_out).toBe(0);
  expect(row.cost_usd).toBe(0);
  // artifact_path should be null for this legacy row
  expect(row.artifact_path).toBeNull();
});

// ---------------------------------------------------------------------------
// All pre-existing indexes are still present
// ---------------------------------------------------------------------------

test('idx_runs_task index survives migration 015 table recreate', () => {
  const db = getDb();
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='runs'")
    .all().map((r) => r.name);
  expect(indexes).toContain('idx_runs_task');
});

test('idx_runs_provider index survives migration 015 table recreate', () => {
  const db = getDb();
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='runs'")
    .all().map((r) => r.name);
  expect(indexes).toContain('idx_runs_provider');
});

test('idx_runs_status index survives migration 015 table recreate', () => {
  const db = getDb();
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='runs'")
    .all().map((r) => r.name);
  expect(indexes).toContain('idx_runs_status');
});

test('idx_runs_proxy_subagent index survives migration 015 table recreate', () => {
  const db = getDb();
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='runs'")
    .all().map((r) => r.name);
  expect(indexes).toContain('idx_runs_proxy_subagent');
});
