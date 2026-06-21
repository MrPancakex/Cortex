/**
 * Smoke tests for migration 012_audit_log_fs_columns.
 *
 * Slice A Phase 4 — verifies that:
 *   - The audit_log table is created with the exact column set from
 *     LEDGER-SCHEMA.md §7.10.
 *   - tasks.folder_path and tasks.fs_version columns exist.
 *   - The three required indexes on audit_log exist.
 *   - The stmts.insertAudit and stmts.listAudit prepared statements work
 *     against a fresh DB (round-trip insert → read-back).
 *   - stmts.countAuditForProject returns the correct count.
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

const ROOT = path.join(os.tmpdir(), `cortex-audit-migration-${process.pid}`);

beforeEach(() => {
  resetTaskStatementsForTests();
  resetDbForTests();
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  process.env.CORTEX_DB_PATH = path.join(ROOT, 'audit-migration.db');
  getDb({ path: process.env.CORTEX_DB_PATH });
  runMigrations();
});

afterEach(() => {
  resetTaskStatementsForTests();
  resetDbForTests();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// audit_log table shape
// ---------------------------------------------------------------------------

test('migration 012 creates the audit_log table', () => {
  const db = getDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  expect(tables).toContain('audit_log');
});

test('migration 012 audit_log has all required columns', () => {
  const db = getDb();
  const cols = db
    .prepare("PRAGMA table_info('audit_log')")
    .all()
    .map((r) => r.name);
  expect(cols).toContain('id');
  expect(cols).toContain('task_id');
  expect(cols).toContain('project_id');
  expect(cols).toContain('actor');
  expect(cols).toContain('event_type');
  expect(cols).toContain('payload');
  expect(cols).toContain('created_at');
  // No extra unexpected columns (exact set check)
  expect(cols.length).toBe(7);
});

test('migration 012 audit_log id is the PRIMARY KEY', () => {
  const db = getDb();
  const colInfo = db.prepare("PRAGMA table_info('audit_log')").all();
  const idCol = colInfo.find((c) => c.name === 'id');
  expect(idCol).toBeDefined();
  expect(idCol.pk).toBe(1);
});

test('migration 012 audit_log payload defaults to empty JSON object', () => {
  const db = getDb();
  const colInfo = db.prepare("PRAGMA table_info('audit_log')").all();
  const payloadCol = colInfo.find((c) => c.name === 'payload');
  expect(payloadCol).toBeDefined();
  // SQLite stores default expressions as text; check the dflt_value field.
  expect(payloadCol.dflt_value).toBe("'{}'");
});

// ---------------------------------------------------------------------------
// tasks column additions
// ---------------------------------------------------------------------------

test('migration 012 adds folder_path column to tasks', () => {
  const db = getDb();
  const cols = db
    .prepare("PRAGMA table_info('tasks')")
    .all()
    .map((r) => r.name);
  expect(cols).toContain('folder_path');
});

test('migration 012 adds fs_version column to tasks', () => {
  const db = getDb();
  const cols = db
    .prepare("PRAGMA table_info('tasks')")
    .all()
    .map((r) => r.name);
  expect(cols).toContain('fs_version');
});

test('migration 012 fs_version has NOT NULL DEFAULT 0', () => {
  const db = getDb();
  const colInfo = db.prepare("PRAGMA table_info('tasks')").all();
  const fsCol = colInfo.find((c) => c.name === 'fs_version');
  expect(fsCol).toBeDefined();
  expect(fsCol.notnull).toBe(1);
  expect(fsCol.dflt_value).toBe('0');
});

test('migration 012 folder_path is nullable (no NOT NULL constraint)', () => {
  const db = getDb();
  const colInfo = db.prepare("PRAGMA table_info('tasks')").all();
  const fpCol = colInfo.find((c) => c.name === 'folder_path');
  expect(fpCol).toBeDefined();
  expect(fpCol.notnull).toBe(0);
});

// ---------------------------------------------------------------------------
// Indexes on audit_log
// ---------------------------------------------------------------------------

test('migration 012 creates idx_audit_log_task_created index', () => {
  const db = getDb();
  const indexes = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_log'",
    )
    .all()
    .map((r) => r.name);
  expect(indexes).toContain('idx_audit_log_task_created');
});

test('migration 012 creates idx_audit_log_project_created index', () => {
  const db = getDb();
  const indexes = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_log'",
    )
    .all()
    .map((r) => r.name);
  expect(indexes).toContain('idx_audit_log_project_created');
});

test('migration 012 creates idx_audit_log_event_created index', () => {
  const db = getDb();
  const indexes = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_log'",
    )
    .all()
    .map((r) => r.name);
  expect(indexes).toContain('idx_audit_log_event_created');
});

// ---------------------------------------------------------------------------
// schema_migrations tracking
// ---------------------------------------------------------------------------

test('migration 012 lands in schema_migrations', () => {
  const db = getDb();
  const rows = db
    .prepare('SELECT id FROM schema_migrations')
    .all()
    .map((r) => r.id);
  expect(rows).toContain('012_audit_log_fs_columns');
});

// ---------------------------------------------------------------------------
// Prepared statement round-trip via insertAudit / listAudit
// ---------------------------------------------------------------------------

test('insertAudit inserts a row and listAudit reads it back', () => {
  const db = getDb();
  const stmts = getTaskStatements();

  // Seed a project and task so the FKs are satisfied.
  const projectId = 'proj-audit-test-001';
  const taskId = 'task-audit-test-001';

  db.prepare(
    `INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)`,
  ).run(projectId, 'Audit Test Project', '/tmp/audit-test');

  db.prepare(
    `INSERT INTO tasks
       (id, project_id, title, description, status, priority, created_by)
     VALUES (?, ?, ?, ?, 'pending', 'medium', 'system')`,
  ).run(taskId, projectId, 'Audit test task', '');

  const auditId = 'aud-00000001-0000-0000-0000-000000000001';
  const payload = JSON.stringify({ title: 'Audit test task', priority: 'medium' });

  // Insert via prepared statement.
  stmts.insertAudit.run(
    auditId,
    taskId,
    projectId,
    'nova',
    'task_created',
    payload,
  );

  // Read back via listAudit.
  const rows = stmts.listAudit.all(projectId);
  expect(rows.length).toBe(1);
  const row = rows[0];
  expect(row.id).toBe(auditId);
  expect(row.task_id).toBe(taskId);
  expect(row.project_id).toBe(projectId);
  expect(row.actor).toBe('nova');
  expect(row.event_type).toBe('task_created');
  expect(row.payload).toBe(payload);
  // created_at must be a non-empty string (set by DEFAULT).
  expect(typeof row.created_at).toBe('string');
  expect(row.created_at.length).toBeGreaterThan(0);
});

test('listAudit returns rows ordered by created_at ASC', () => {
  const db = getDb();
  const stmts = getTaskStatements();

  const projectId = 'proj-audit-order-001';
  const taskId = 'task-audit-order-001';

  db.prepare(
    `INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)`,
  ).run(projectId, 'Order Test Project', '/tmp/order-test');

  db.prepare(
    `INSERT INTO tasks
       (id, project_id, title, description, status, priority, created_by)
     VALUES (?, ?, ?, ?, 'pending', 'medium', 'system')`,
  ).run(taskId, projectId, 'Order test task', '');

  // Insert two rows with explicit created_at to test ordering.
  db.prepare(
    `INSERT INTO audit_log
       (id, task_id, project_id, actor, event_type, payload, created_at)
     VALUES (?, ?, ?, ?, ?, '{}', ?)`,
  ).run('aud-order-002', taskId, projectId, 'system', 'task_claimed', '2026-05-25T10:01:00');

  db.prepare(
    `INSERT INTO audit_log
       (id, task_id, project_id, actor, event_type, payload, created_at)
     VALUES (?, ?, ?, ?, ?, '{}', ?)`,
  ).run('aud-order-001', taskId, projectId, 'system', 'task_created', '2026-05-25T10:00:00');

  const rows = stmts.listAudit.all(projectId);
  expect(rows.length).toBe(2);
  // Earlier timestamp must come first.
  expect(rows[0].event_type).toBe('task_created');
  expect(rows[1].event_type).toBe('task_claimed');
});

// ---------------------------------------------------------------------------
// countAuditForProject — parity invariant helper
// ---------------------------------------------------------------------------

test('countAuditForProject returns 0 for a project with no audit rows', () => {
  const db = getDb();
  const stmts = getTaskStatements();

  const projectId = 'proj-count-empty-001';
  db.prepare(
    `INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)`,
  ).run(projectId, 'Count Empty Project', '/tmp/count-empty');

  const result = stmts.countAuditForProject.get(projectId);
  expect(result.n).toBe(0);
});

test('countAuditForProject returns correct count after inserts', () => {
  const db = getDb();
  const stmts = getTaskStatements();

  const projectId = 'proj-count-test-001';
  const taskId = 'task-count-test-001';

  db.prepare(
    `INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)`,
  ).run(projectId, 'Count Test Project', '/tmp/count-test');

  db.prepare(
    `INSERT INTO tasks
       (id, project_id, title, description, status, priority, created_by)
     VALUES (?, ?, ?, ?, 'pending', 'medium', 'system')`,
  ).run(taskId, projectId, 'Count test task', '');

  stmts.insertAudit.run('aud-cnt-01', taskId, projectId, 'system', 'task_created', '{}');
  stmts.insertAudit.run('aud-cnt-02', taskId, projectId, 'nova', 'task_claimed', '{}');
  stmts.insertAudit.run('aud-cnt-03', taskId, projectId, 'nova', 'task_progressed', '{}');

  const result = stmts.countAuditForProject.get(projectId);
  expect(result.n).toBe(3);
});

test('countAuditForProject counts only rows for the specified project', () => {
  const db = getDb();
  const stmts = getTaskStatements();

  const projA = 'proj-scope-a-001';
  const projB = 'proj-scope-b-001';
  const taskA = 'task-scope-a-001';
  const taskB = 'task-scope-b-001';

  db.prepare(`INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)`).run(projA, 'Scope A', '/tmp/scope-a');
  db.prepare(`INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)`).run(projB, 'Scope B', '/tmp/scope-b');

  db.prepare(
    `INSERT INTO tasks (id, project_id, title, description, status, priority, created_by)
     VALUES (?, ?, ?, ?, 'pending', 'medium', 'system')`,
  ).run(taskA, projA, 'Scope A task', '');
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, description, status, priority, created_by)
     VALUES (?, ?, ?, ?, 'pending', 'medium', 'system')`,
  ).run(taskB, projB, 'Scope B task', '');

  stmts.insertAudit.run('aud-scope-a-01', taskA, projA, 'system', 'task_created', '{}');
  stmts.insertAudit.run('aud-scope-a-02', taskA, projA, 'nova', 'task_claimed', '{}');
  stmts.insertAudit.run('aud-scope-b-01', taskB, projB, 'system', 'task_created', '{}');

  expect(stmts.countAuditForProject.get(projA).n).toBe(2);
  expect(stmts.countAuditForProject.get(projB).n).toBe(1);
});

// ---------------------------------------------------------------------------
// FK cascade on task delete
// ---------------------------------------------------------------------------

test('audit_log rows are cascade-deleted when the parent task is deleted', () => {
  const db = getDb();
  const stmts = getTaskStatements();

  const projectId = 'proj-cascade-test-001';
  const taskId = 'task-cascade-test-001';

  db.prepare(`INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)`).run(projectId, 'Cascade Project', '/tmp/cascade');
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, description, status, priority, created_by)
     VALUES (?, ?, ?, ?, 'pending', 'medium', 'system')`,
  ).run(taskId, projectId, 'Cascade task', '');

  stmts.insertAudit.run('aud-casc-01', taskId, projectId, 'system', 'task_created', '{}');

  expect(stmts.countAuditForProject.get(projectId).n).toBe(1);

  db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);

  expect(stmts.countAuditForProject.get(projectId).n).toBe(0);
});
