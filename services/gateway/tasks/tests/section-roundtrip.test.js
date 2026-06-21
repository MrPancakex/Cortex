/**
 * Section round-trip tests — regression lock for the per-task `section` field
 * (a task's style/category, e.g. "MCP & Tools").
 *
 * `section` regressed when core/schemas/task.js (the live @cortex/core/schemas)
 * dropped it from TaskCreateSchema / never carried it on TaskUpdateSchema during
 * the Phase 1 lift, so the create/update handlers parsed it away before storing
 * it. The handlers themselves (transitions.js createTask / updateTask) already
 * persist section into the metadata JSON blob; task-projection already round-trips
 * it to task.json. These tests prove the full path now works end-to-end:
 *   create WITH section → persists in metadata → getTask serializer returns it
 *   top-level → list summary returns it → task.json carries it → README
 *   front-matter emits it → update can change it and clear it (null).
 *
 * Each test runs against a fresh tmpdir DB + tmpdir projects root.
 * NEVER touches $CORTEX_HOME/state/cortex.db.
 *
 * Run with:
 *   cd $CORTEX_HOME && bun test services/gateway/tasks/tests/section-roundtrip.test.js
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
import { createTask, updateTask } from '../transitions.js';
import { getTask, listTasks } from '../queries.js';
import { renderTaskReadme } from '../readme.js';

let ROOT;
let PROJECTS_DIR;
let db;
let stmts;

beforeEach(() => {
  resetTaskStatementsForTests();
  resetDbForTests();

  const rand = randomUUID().slice(0, 8);
  ROOT = path.join(os.tmpdir(), `cortex-section-${process.pid}-${rand}`);
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

function makeProject() {
  const id = randomUUID();
  const slug = `proj-${id.slice(0, 8)}`;
  const rootPath = path.join(PROJECTS_DIR, slug);
  fs.mkdirSync(path.join(rootPath, 'tasks'), { recursive: true });
  db.prepare(
    `INSERT INTO projects (id, name, root_path, metadata) VALUES (?, ?, ?, '{}')`,
  ).run(id, slug, rootPath);
  const phaseId = randomUUID();
  stmts.createPhase.run(phaseId, id, 'Phase 1', 0);
  return { id, slug, rootPath, phaseId };
}

function actor(id) { return { id }; }

// ---------------------------------------------------------------------------
// 1. create WITH section → persists in metadata → getTask returns top-level
// ---------------------------------------------------------------------------

test('createTask accepts a section and getTask returns it top-level + nested', () => {
  const { id: projectId } = makeProject();

  const res = createTask({
    body: {
      project_id: projectId,
      title: 'Section task',
      phase_number: 1,
      section: 'MCP & Tools',
    },
    actor: actor('system'),
    isAdmin: true,
  });
  expect(res.status).toBe(201);
  const taskId = res.body.id;

  // Stored in metadata blob
  const row = stmts.getTask.get(taskId);
  expect(JSON.parse(row.metadata).section).toBe('MCP & Tools');

  // getTask serializer exposes it top-level AND keeps it inside metadata
  const got = getTask({ taskId });
  expect(got.status).toBe(200);
  expect(got.body.section).toBe('MCP & Tools');
  expect(got.body.metadata.section).toBe('MCP & Tools');
});

// ---------------------------------------------------------------------------
// 2. create WITHOUT section → metadata has no section key; reads return null
// ---------------------------------------------------------------------------

test('createTask without section keeps metadata clean and reads null', () => {
  const { id: projectId } = makeProject();

  const res = createTask({
    body: { project_id: projectId, title: 'No section', phase_number: 1 },
    actor: actor('system'),
    isAdmin: true,
  });
  expect(res.status).toBe(201);
  const taskId = res.body.id;

  const row = stmts.getTask.get(taskId);
  expect('section' in JSON.parse(row.metadata)).toBe(false);

  const got = getTask({ taskId });
  expect(got.body.section).toBeNull();
});

// ---------------------------------------------------------------------------
// 3. list summary returns section top-level
// ---------------------------------------------------------------------------

test('listTasks summary includes section', () => {
  const { id: projectId } = makeProject();
  createTask({
    body: { project_id: projectId, title: 'Listed', phase_number: 1, section: 'Gateway' },
    actor: actor('system'),
    isAdmin: true,
  });

  const list = listTasks({ query: { project_id: projectId }, isAdmin: true });
  expect(list.body.tasks).toHaveLength(1);
  expect(list.body.tasks[0].section).toBe('Gateway');
});

// ---------------------------------------------------------------------------
// 4. updateTask changes the section, then clears it with null
// ---------------------------------------------------------------------------

test('updateTask sets a new section then clears it with null', () => {
  const { id: projectId } = makeProject();
  const created = createTask({
    body: { project_id: projectId, title: 'Updatable', phase_number: 1, section: 'Old' },
    actor: actor('admin'),
    isAdmin: true,
  });
  const taskId = created.body.id;

  // Change section
  const upd = updateTask({
    taskId, actor: actor('admin'), isAdmin: true,
    body: { section: 'New Section' },
  });
  expect(upd.status).toBe(200);
  expect(upd.body.fields_changed).toContain('section');
  expect(getTask({ taskId }).body.section).toBe('New Section');

  // Clear section (null) — the "fall back to General" path
  const cleared = updateTask({
    taskId, actor: actor('admin'), isAdmin: true,
    body: { section: null },
  });
  expect(cleared.status).toBe(200);
  expect(cleared.body.fields_changed).toContain('section');
  const after = getTask({ taskId });
  expect(after.body.section).toBeNull();
  expect('section' in after.body.metadata).toBe(false);
});

// ---------------------------------------------------------------------------
// 5. task.json projection on disk carries section after create
// ---------------------------------------------------------------------------

test('task.json on disk carries the section after createTask', () => {
  const { id: projectId, rootPath } = makeProject();
  const res = createTask({
    body: { project_id: projectId, title: 'Disk task', phase_number: 1, section: 'Schemas' },
    actor: actor('system'),
    isAdmin: true,
  });
  const taskId = res.body.id;

  const phaseDir = path.join(rootPath, 'tasks', 'phase-1');
  const taskDir = fs.readdirSync(phaseDir)
    .map((e) => path.join(phaseDir, e))
    .find((d) => { try { return fs.statSync(d).isDirectory(); } catch (_) { return false; } });
  const taskJson = JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8'));
  expect(taskJson.id).toBe(taskId);
  expect(taskJson.section).toBe('Schemas');
});

// ---------------------------------------------------------------------------
// 6. README front-matter emits section only when present
// ---------------------------------------------------------------------------

test('renderTaskReadme emits a section front-matter line when present', () => {
  const body = renderTaskReadme({
    id: 'abc', title: 'T', status: 'pending', created_at: Date.now(),
    assigned_to: null, metadata: JSON.stringify({ section: 'MCP & Tools' }),
  }, {});
  expect(body).toMatch(/^---\ntask_id: abc/);
  expect(body).toMatch('section: MCP & Tools');
});

test('renderTaskReadme omits the section line when absent', () => {
  const body = renderTaskReadme({
    id: 'abc', title: 'T', status: 'pending', created_at: Date.now(),
    assigned_to: null, metadata: JSON.stringify({ source: 'agent' }),
  }, {});
  expect(body).toMatch(/^---\ntask_id: abc/);
  expect(body).not.toMatch(/\nsection:/);
});
