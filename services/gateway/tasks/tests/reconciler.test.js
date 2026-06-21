/**
 * Tests for reconciler.js — Slice A Phase 5.
 *
 * Run with: cd $CORTEX_HOME && bun test services/gateway/tasks/tests/reconciler.test.js
 *
 * Each test uses a fresh tmpdir DB + fresh tmpdir projects root.
 * env vars: CORTEX_DB_PATH (DB path), CORTEX_PROJECTS_DIR (projects root).
 * NEVER touches $CORTEX_HOME/state/cortex.db.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { getDb, runMigrations, resetDbForTests } from '@cortex/sdk/db';
import {
  getTaskStatements,
  resetTaskStatementsForTests,
} from '@cortex/gateway/tasks';
import { scanAll, reconcileProjectById } from '../reconciler.js';
import { writeTaskJson } from '../ledger.js';
import { appendLedger } from '../ledger.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let ROOT;
let PROJECTS_DIR;
let db;
let stmts;

beforeEach(() => {
  resetTaskStatementsForTests();
  resetDbForTests();

  const rand = randomUUID().slice(0, 8);
  ROOT = path.join(os.tmpdir(), `cortex-reconciler-${process.pid}-${rand}`);
  PROJECTS_DIR = path.join(ROOT, 'projects');
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });

  process.env.CORTEX_DB_PATH = path.join(ROOT, 'test.db');
  process.env.CORTEX_PROJECTS_DIR = PROJECTS_DIR;

  db = getDb({ path: process.env.CORTEX_DB_PATH });
  runMigrations();
  stmts = getTaskStatements();
});

afterEach(() => {
  resetTaskStatementsForTests();
  resetDbForTests();
  delete process.env.CORTEX_DB_PATH;
  delete process.env.CORTEX_PROJECTS_DIR;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function makeProjectOnDisk({ id, slug, rootPath }) {
  fs.mkdirSync(path.join(rootPath, 'tasks'), { recursive: true });
  db.prepare(
    `INSERT INTO projects (id, name, root_path, metadata)
     VALUES (?, ?, ?, '{}')`,
  ).run(id, slug, rootPath);
  return { id, slug, root_path: rootPath };
}

function makePhase({ projectId, ordinal = 0, id }) {
  const phaseId = id ?? randomUUID();
  const phaseName = `Phase ${ordinal + 1}`;
  stmts.createPhase.run(phaseId, projectId, phaseName, ordinal);
  return phaseId;
}

/**
 * Write a task.json file to disk at the expected folder path, optionally
 * also inserting the task row into the DB.
 */
function makeTaskOnDisk({
  projectRootPath,
  phaseNumber = 1,
  taskId,
  title = 'Test Task',
  status = 'pending',
  priority = 'normal',
  fsVersion = 0,
}) {
  const phaseDir = path.join(projectRootPath, 'tasks', `phase-${phaseNumber}`);
  const taskDir = path.join(phaseDir, `Task 1 - ${title}`);
  fs.mkdirSync(taskDir, { recursive: true });

  const taskJson = {
    schema_version: 1,
    id: taskId,
    project_id: null, // reconciler gets this from the project row
    phase_id: null,
    phase_number: phaseNumber,
    folder_path: taskDir,
    title,
    status,
    priority,
    assigned_to: null,
    created_by: 'nova',
    created_at: '2026-05-25T10:00:00.000Z',
    updated_at: '2026-05-25T10:00:00.000Z',
    claimed_at: null,
    submitted_at: null,
    approved_at: null,
    deadline: null,
    description: 'Test description',
    result: null,
    tags: [],
    section: null,
    rejection_count: 0,
    parent_task_id: null,
    reviewer_agent: null,
    provider: null,
    lease_token: null,
    lease_expires_at: null,
    fs_version: fsVersion,
  };

  writeTaskJson(taskDir, taskJson);
  return { taskDir, taskJson };
}

function insertDbTask({ projectId, phaseId = null, taskId, title, status = 'pending', fsVersion = 0, description = 'Test description' }) {
  db.prepare(
    `INSERT INTO tasks
       (id, project_id, phase_id, title, description, status, priority,
        created_by, tags, metadata, rejection_count,
        created_at, updated_at, fs_version)
     VALUES (?, ?, ?, ?, ?, ?, 'normal', 'nova', '[]', '{}', 0,
             '2026-05-25T10:00:00', '2026-05-25T10:00:00', ?)`,
  ).run(taskId, projectId, phaseId, title, description, status, fsVersion);
}

// ---------------------------------------------------------------------------
// Test 1: Empty fs, empty DB → zero diff
// ---------------------------------------------------------------------------

test('1. empty fs + empty DB → scanAll returns zero diff', async () => {
  const projectId = randomUUID();
  const rootPath = path.join(PROJECTS_DIR, 'empty-proj');
  makeProjectOnDisk({ id: projectId, slug: 'empty-proj', rootPath });

  const diff = await scanAll();

  expect(diff.totals.added).toBe(0);
  expect(diff.totals.updated).toBe(0);
  expect(diff.totals.removed).toBe(0);
});

// ---------------------------------------------------------------------------
// Test 2: fs has 1 task, DB empty → insert; second run → zero diff
// ---------------------------------------------------------------------------

test('2. fs has 1 task, DB empty → inserts; second run is zero diff (idempotent)', async () => {
  const projectId = randomUUID();
  const rootPath = path.join(PROJECTS_DIR, 'new-task-proj');
  makeProjectOnDisk({ id: projectId, slug: 'new-task-proj', rootPath });

  const taskId = randomUUID();
  makeTaskOnDisk({ projectRootPath: rootPath, taskId, title: 'New Task' });

  // First run
  const diff1 = await scanAll({ dryRun: false });
  expect(diff1.totals.added).toBe(1);
  expect(diff1.totals.updated).toBe(0);

  // Verify the row exists in DB
  const row = stmts.getTask.get(taskId);
  expect(row).toBeDefined();
  expect(row.id).toBe(taskId);
  expect(row.title).toBe('New Task');

  // Second run: zero diff (idempotency)
  const diff2 = await scanAll({ dryRun: false });
  expect(diff2.totals.added).toBe(0);
  expect(diff2.totals.updated).toBe(0);
  expect(diff2.totals.removed).toBe(0);
});

// ---------------------------------------------------------------------------
// Test 3: fs has 1 task, DB has same task with identical projection → zero diff
// ---------------------------------------------------------------------------

test('3. fs + DB identical projection → zero diff (no UPDATE)', async () => {
  const projectId = randomUUID();
  const rootPath = path.join(PROJECTS_DIR, 'identical-proj');
  makeProjectOnDisk({ id: projectId, slug: 'identical-proj', rootPath });
  const phaseId = makePhase({ projectId, ordinal: 0 });

  const taskId = randomUUID();
  makeTaskOnDisk({ projectRootPath: rootPath, taskId, title: 'Same Task', fsVersion: 1 });
  insertDbTask({ projectId, phaseId, taskId, title: 'Same Task', status: 'pending', fsVersion: 1 });

  const diff = await scanAll({ dryRun: false });
  expect(diff.totals.added).toBe(0);
  expect(diff.totals.updated).toBe(0);
  expect(diff.totals.removed).toBe(0);
});

// ---------------------------------------------------------------------------
// Test 4: fs has task, DB has same task but status differs → UPDATE; fs wins
// ---------------------------------------------------------------------------

test('4. status diverges → UPDATE issued, fs status wins, fs_version increments, fields_changed includes status', async () => {
  const projectId = randomUUID();
  const rootPath = path.join(PROJECTS_DIR, 'drift-proj');
  makeProjectOnDisk({ id: projectId, slug: 'drift-proj', rootPath });
  const phaseId = makePhase({ projectId, ordinal: 0 });

  const taskId = randomUUID();
  // fs: status = 'in_progress', fsVersion = 2
  makeTaskOnDisk({ projectRootPath: rootPath, taskId, title: 'Drifted Task', status: 'in_progress', fsVersion: 2 });
  // DB: status = 'pending', fsVersion = 1 (older)
  insertDbTask({ projectId, phaseId, taskId, title: 'Drifted Task', status: 'pending', fsVersion: 1 });

  const dbBefore = stmts.getTask.get(taskId);
  expect(dbBefore.fs_version).toBe(1);

  const diff = await scanAll({ dryRun: false });
  expect(diff.totals.updated).toBe(1);

  const projectDiff = diff.projects[0];
  const taskDiff = projectDiff.tasks.find((t) => t.task_id === taskId);
  expect(taskDiff).toBeDefined();
  expect(taskDiff.action).toBe('updated');
  expect(taskDiff.fields_changed).toContain('status');

  // DB row now has fs status
  const dbAfter = stmts.getTask.get(taskId);
  expect(dbAfter.status).toBe('in_progress');

  // fs_version bumped by 1 (was 1, now 2 via SQL fs_version + 1)
  expect(dbAfter.fs_version).toBe(2);
});

// ---------------------------------------------------------------------------
// Test 5: fs missing, DB has task → removed; no DB delete
// ---------------------------------------------------------------------------

test('5. DB has task with no task.json on disk → removed count=1, row NOT deleted', async () => {
  const projectId = randomUUID();
  const rootPath = path.join(PROJECTS_DIR, 'orphan-proj');
  makeProjectOnDisk({ id: projectId, slug: 'orphan-proj', rootPath });
  const phaseId = makePhase({ projectId, ordinal: 0 });

  const taskId = randomUUID();
  // Only in DB, no task.json on disk
  insertDbTask({ projectId, phaseId, taskId, title: 'Orphan Task', fsVersion: 0 });

  const rowsBefore = db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE project_id = ?').get(projectId);
  expect(rowsBefore.c).toBe(1);

  const diff = await scanAll({ dryRun: false });
  expect(diff.totals.removed).toBe(1);

  const projectDiff = diff.projects[0];
  const taskDiff = projectDiff.tasks.find((t) => t.task_id === taskId);
  expect(taskDiff).toBeDefined();
  expect(taskDiff.action).toBe('removed');

  // Row still exists in DB (NOT deleted)
  const rowsAfter = db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE project_id = ?').get(projectId);
  expect(rowsAfter.c).toBe(1);
});

// ---------------------------------------------------------------------------
// Test 6: dry-run mode → diff produced but DB unchanged
// ---------------------------------------------------------------------------

test('6. dry-run: diff produced but DB not modified', async () => {
  const projectId = randomUUID();
  const rootPath = path.join(PROJECTS_DIR, 'dryrun-proj');
  makeProjectOnDisk({ id: projectId, slug: 'dryrun-proj', rootPath });

  const taskId = randomUUID();
  makeTaskOnDisk({ projectRootPath: rootPath, taskId, title: 'Dry Run Task' });

  const countBefore = db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c;

  const diff = await scanAll({ dryRun: true });
  expect(diff.dry_run).toBe(true);
  expect(diff.totals.added).toBe(1);

  // DB unchanged
  const countAfter = db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c;
  expect(countAfter).toBe(countBefore);

  // Now run for real
  const diff2 = await scanAll({ dryRun: false });
  expect(diff2.totals.added).toBe(1);

  const countFinal = db.prepare('SELECT COUNT(*) AS c FROM tasks').get().c;
  expect(countFinal).toBe(countBefore + 1);
});

// ---------------------------------------------------------------------------
// Test 7: parity check passes
// ---------------------------------------------------------------------------

test('7. parity check passes when ledger.jsonl lines == audit_log rows', async () => {
  const projectId = randomUUID();
  const rootPath = path.join(PROJECTS_DIR, 'parity-ok-proj');
  makeProjectOnDisk({ id: projectId, slug: 'parity-ok-proj', rootPath });

  // Write 3 ledger lines
  for (let i = 0; i < 3; i++) {
    appendLedger(rootPath, {
      ts: new Date().toISOString(),
      task_id: randomUUID(),
      project_id: projectId,
      actor: 'system',
      event_type: 'task_created',
      from_status: null,
      to_status: 'pending',
      data: { title: `Task ${i}` },
    });
  }

  // Insert 3 audit_log rows (matching count)
  const taskId = randomUUID();
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, description, status, priority, created_by, tags, metadata, rejection_count)
     VALUES (?, ?, 'Parity task', '', 'pending', 'normal', 'system', '[]', '{}', 0)`,
  ).run(taskId, projectId);
  stmts.insertAudit.run(randomUUID(), taskId, projectId, 'system', 'task_created', '{}');
  stmts.insertAudit.run(randomUUID(), taskId, projectId, 'nova', 'task_claimed', '{}');
  stmts.insertAudit.run(randomUUID(), taskId, projectId, 'nova', 'task_progressed', '{}');

  const diff = await scanAll({ dryRun: true });
  const projResult = diff.projects.find((p) => p.project_id === projectId);
  expect(projResult).toBeDefined();
  expect(projResult.parity_ok).toBe(true);
});

// ---------------------------------------------------------------------------
// Test 8: parity check fails; reconciler does NOT throw
// ---------------------------------------------------------------------------

test('8. parity fails (3 ledger lines, 2 audit rows) → parity_ok=false; no throw', async () => {
  const projectId = randomUUID();
  const rootPath = path.join(PROJECTS_DIR, 'parity-fail-proj');
  makeProjectOnDisk({ id: projectId, slug: 'parity-fail-proj', rootPath });

  // 3 ledger lines
  for (let i = 0; i < 3; i++) {
    appendLedger(rootPath, {
      ts: new Date().toISOString(),
      task_id: randomUUID(),
      project_id: projectId,
      actor: 'system',
      event_type: 'task_created',
      from_status: null,
      to_status: 'pending',
      data: { title: `Task ${i}` },
    });
  }

  // Only 2 audit_log rows (mismatch)
  const taskId = randomUUID();
  db.prepare(
    `INSERT INTO tasks (id, project_id, title, description, status, priority, created_by, tags, metadata, rejection_count)
     VALUES (?, ?, 'Parity task', '', 'pending', 'normal', 'system', '[]', '{}', 0)`,
  ).run(taskId, projectId);
  stmts.insertAudit.run(randomUUID(), taskId, projectId, 'system', 'task_created', '{}');
  stmts.insertAudit.run(randomUUID(), taskId, projectId, 'nova', 'task_claimed', '{}');

  // Must not throw
  let diff;
  let threw = false;
  try {
    diff = await scanAll({ dryRun: true });
  } catch (_) {
    threw = true;
  }

  expect(threw).toBe(false);
  const projResult = diff.projects.find((p) => p.project_id === projectId);
  expect(projResult.parity_ok).toBe(false);
  expect(diff.totals.parity_failures).toBe(1);
});

// ---------------------------------------------------------------------------
// Test 9: projectFilter narrows scope
// ---------------------------------------------------------------------------

test('9. projectFilter narrows scan to one project', async () => {
  const projAId = randomUUID();
  const projBId = randomUUID();
  const rootA = path.join(PROJECTS_DIR, 'proj-a');
  const rootB = path.join(PROJECTS_DIR, 'proj-b');
  makeProjectOnDisk({ id: projAId, slug: 'proj-a', rootPath: rootA });
  makeProjectOnDisk({ id: projBId, slug: 'proj-b', rootPath: rootB });

  const taskA = randomUUID();
  const taskB = randomUUID();
  makeTaskOnDisk({ projectRootPath: rootA, taskId: taskA, title: 'Task A' });
  makeTaskOnDisk({ projectRootPath: rootB, taskId: taskB, title: 'Task B' });

  // Filter to proj-a only
  const diff = await scanAll({ dryRun: false, projectFilter: projAId });

  expect(diff.projects.length).toBe(1);
  expect(diff.projects[0].project_id).toBe(projAId);
  expect(diff.totals.added).toBe(1);

  // proj-b task was NOT inserted (getTask returns null when absent in bun:sqlite)
  const rowB = stmts.getTask.get(taskB);
  expect(rowB == null).toBe(true);

  // proj-a task WAS inserted
  const rowA = stmts.getTask.get(taskA);
  expect(rowA).toBeDefined();
});

// ---------------------------------------------------------------------------
// Test 10: phase_id resolution — folder phase-2 creates the phase if missing
// ---------------------------------------------------------------------------

test('10. phase_id resolution: task at phase-2 folder creates phase row if absent', async () => {
  const projectId = randomUUID();
  const rootPath = path.join(PROJECTS_DIR, 'phase-create-proj');
  makeProjectOnDisk({ id: projectId, slug: 'phase-create-proj', rootPath });

  // No phase row seeded — reconciler must create it
  const taskId = randomUUID();
  makeTaskOnDisk({
    projectRootPath: rootPath,
    phaseNumber: 2,
    taskId,
    title: 'Phase 2 Task',
  });

  await scanAll({ dryRun: false });

  // Phase row for ordinal=1 (phase number 2) must now exist
  const phaseRows = db.prepare('SELECT * FROM phases WHERE project_id = ? AND ordinal = ?').all(projectId, 1);
  expect(phaseRows.length).toBe(1);

  // Task row must be linked to that phase
  const taskRow = stmts.getTask.get(taskId);
  expect(taskRow).toBeDefined();
  expect(taskRow.phase_id).toBe(phaseRows[0].id);
});
