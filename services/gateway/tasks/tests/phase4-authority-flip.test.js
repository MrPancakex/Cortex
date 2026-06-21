/**
 * Phase 4 acceptance tests — D1 (CORTEX_FOLDER_AUTHORITY flag) + D2 (admin-socket reconcile
 * trigger) + D3 divergence-injection proofs.
 *
 * Contract from the bounded spec:
 *   D3a. Direct sqlite UPDATE of a task's status (fs_version untouched) →
 *        run reconcile → FS value RESTORED + report.updated=1 + fields_changed includes 'status'.
 *   D3b. Inverse guard: DB legitimately ahead (fs_version bumped beyond task.json) →
 *        reconcile SKIPS that task (no clobber).
 *   D3c. Read-path unchanged: getTask/listTasks have no CORTEX_FOLDER_AUTHORITY branch
 *        (verified via code-read + assertion that reads remain DB-direct with flag on/off).
 *   D1.  CORTEX_FOLDER_AUTHORITY is a flag-read assertion only — boot reconcile (scanAll)
 *        is unconditional existing behavior and is NOT gated by this flag. The flag only
 *        enables the D2 admin endpoint + authority declaration.
 *   D2.  TCP attempt → 403 admin_scope_requires_unix_socket;
 *        flag OFF → 404; flag ON + isAdminSocket → 200 + diff report shape.
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
import {
  getSessionStatements,
  resetSessionStatementsForTests,
} from '../../sessions/statements.js';
import {
  createTask,
  claimTask,
} from '../transitions.js';
import { getTask, listTasks } from '../queries.js';
import { scanAll } from '../reconciler.js';
import { mountTaskRoutes } from '../routes.js';
import { findTaskFolderByUuid, getPhaseDir, getProjectDir } from '../folders.js';

// ---------------------------------------------------------------------------
// Fixture setup (matches Phase-3 pattern: fresh tmpdir per test)
// ---------------------------------------------------------------------------

let ROOT;
let PROJECTS_DIR;
let db;
let stmts;

beforeEach(() => {
  resetTaskStatementsForTests();
  resetSessionStatementsForTests();
  resetDbForTests();
  const rand = randomUUID().slice(0, 8);
  ROOT = path.join(os.tmpdir(), `cortex-p4-${process.pid}-${rand}`);
  PROJECTS_DIR = path.join(ROOT, 'projects');
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  process.env.CORTEX_DB_PATH = path.join(ROOT, 'test.db');
  process.env.CORTEX_PROJECTS_DIR = PROJECTS_DIR;
  db = getDb({ path: process.env.CORTEX_DB_PATH });
  runMigrations();
  stmts = getTaskStatements();
  // Pre-register a test agent so claimTask() FK check passes.
  getSessionStatements().insertAgent.run(
    'test-agent', 'Test Agent', 'bot', 'online',
    JSON.stringify([]), null, null, '{}', 'linux',
  );
});

afterEach(() => {
  resetTaskStatementsForTests();
  resetSessionStatementsForTests();
  resetDbForTests();
  delete process.env.CORTEX_DB_PATH;
  delete process.env.CORTEX_PROJECTS_DIR;
  delete process.env.CORTEX_FOLDER_AUTHORITY;
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProject(slug) {
  const id = randomUUID();
  const s = slug ?? `proj-${id.slice(0, 8)}`;
  const rootPath = path.join(PROJECTS_DIR, s);
  fs.mkdirSync(path.join(rootPath, 'tasks'), { recursive: true });

  const projectJson = {
    schema_version: 1,
    id,
    slug: s,
    name: s,
    description: `Test project ${s}`,
    root_path: rootPath,
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(rootPath, 'project.json'), JSON.stringify(projectJson), 'utf8');

  db.prepare(
    `INSERT INTO projects (id, name, description, root_path, metadata) VALUES (?, ?, ?, ?, '{}')`,
  ).run(id, s, s, rootPath);
  const phaseId = randomUUID();
  stmts.createPhase.run(phaseId, id, 'Phase 1', 0);
  return { id, slug: s, rootPath, phaseId };
}

const actor = (id) => ({ id });

function createRealTask({ projectId, title = 'Test Task' }) {
  const res = createTask({
    body: { project_id: projectId, title, phase_number: 1, priority: 'high' },
    actor: actor('system'),
    isAdmin: true,
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

/**
 * Build a minimal route adapter that records dispatched calls and returns
 * whatever the handler returns. isAdminSocket controls whether the "unix socket"
 * channel is simulated. Supports :param wildcards for GET /v1/api/tasks/:id etc.
 */
function makeAdapter(isAdminSocket = false) {
  const routes = [];
  const adapter = {
    add(method, routePath, handler) {
      routes.push({ method, path: routePath, handler });
    },
    dispatch(method, routePath, body = null, query = {}) {
      // Try exact match first, then pattern match for :param segments.
      let r = routes.find((x) => x.method === method && x.path === routePath);
      let params = {};
      if (!r) {
        for (const route of routes) {
          if (route.method !== method) continue;
          const patternParts = route.path.split('/');
          const pathParts = routePath.split('/');
          if (patternParts.length !== pathParts.length) continue;
          const matched = patternParts.every((seg, i) => seg.startsWith(':') || seg === pathParts[i]);
          if (matched) {
            patternParts.forEach((seg, i) => {
              if (seg.startsWith(':')) params[seg.slice(1)] = pathParts[i];
            });
            r = route;
            break;
          }
        }
      }
      if (!r) return { status: 404, body: { error: 'no_route' } };
      return r.handler({ body, query, params, isAdminSocket, isAdmin: isAdminSocket, actor: { id: 'admin', kind: 'admin' } });
    },
  };
  return adapter;
}

// ---------------------------------------------------------------------------
// D3a — direct DB injection → reconcile RESTORES FS value
// ---------------------------------------------------------------------------

test('p4.d3a reconcile restores DB-mutated status from task.json', async () => {
  const { id: projectId } = makeProject();
  const taskId = createRealTask({ projectId, title: 'Reconcile Me' });

  // Run a first pass so task.json is written to disk and folder_path populated.
  await scanAll({ dryRun: false });

  const dbRow = stmts.getTask.get(taskId);
  expect(dbRow.status).toBe('pending');

  // Locate the task folder using the actual folder-lookup function.
  const project = stmts.getProject.get(dbRow.project_id);
  const phaseDir = getPhaseDir(project, 1);
  const taskDir = findTaskFolderByUuid(phaseDir, taskId);
  expect(taskDir).toBeTruthy();

  const taskJsonPath = path.join(taskDir, 'task.json');
  expect(fs.existsSync(taskJsonPath)).toBe(true);
  const taskJsonBefore = JSON.parse(fs.readFileSync(taskJsonPath, 'utf8'));
  expect(taskJsonBefore.status).toBe('pending');
  const fsVersion = taskJsonBefore.fs_version ?? 0;

  // INJECTION: directly mutate DB status without bumping fs_version.
  // This is exactly the divergence class the authority flip guards against.
  db.prepare(`UPDATE tasks SET status = 'in_progress' WHERE id = ?`).run(taskId);
  expect(stmts.getTask.get(taskId).status).toBe('in_progress');
  // fs_version in DB must still match file (injection bypassed dualWrite)
  expect(stmts.getTask.get(taskId).fs_version ?? 0).toBe(fsVersion);

  // Run reconcile — FS wins because fs_version (file) >= fs_version (DB)
  const diff = await scanAll({ dryRun: false });

  // Verify restoration
  const rowAfter = stmts.getTask.get(taskId);
  expect(rowAfter.status).toBe('pending');

  // F5 (Phase 4 R5): after FS-win repair, DB fs_version MUST equal task.json
  // fs_version (not incremented beyond the file).
  const taskJsonAfter = JSON.parse(fs.readFileSync(taskJsonPath, 'utf8'));
  expect(rowAfter.fs_version).toBe(taskJsonAfter.fs_version ?? 0);

  // Verify report shape — exact counts (fixture creates exactly 1 task)
  expect(diff.totals.updated).toBe(1);
  const projectResult = diff.projects.find((p) => p.project_id === projectId);
  expect(projectResult).toBeTruthy();
  expect(projectResult.updated).toBe(1);
  const taskEntry = projectResult.tasks.find((t) => t.task_id === taskId);
  expect(taskEntry).toBeTruthy();
  expect(taskEntry.action).toBe('updated');
  // Exact fields_changed content: only 'status' was injected, so only 'status' drifted
  expect(taskEntry.fields_changed).toEqual(['status']);

  // F5 steady-state: a second scanAll after the repair must report NO further
  // divergence (idempotency — the version gate must not re-fire the update).
  const diff2 = await scanAll({ dryRun: false });
  expect(diff2.totals.updated).toBe(0);
  const projectResult2 = diff2.projects.find((p) => p.project_id === projectId);
  const hasUpdate2 = projectResult2?.tasks.some((t) => t.task_id === taskId && t.action === 'updated');
  expect(hasUpdate2).toBeFalsy();
});

// ---------------------------------------------------------------------------
// D3b — DB legitimately ahead (fs_version bumped) → reconcile SKIPS
// ---------------------------------------------------------------------------

test('p4.d3b reconcile skips task when DB fs_version > file fs_version (REAL transition proof)', async () => {
  // ROOT D contract: create the DB-ahead state via a REAL claimTask() which bumps
  // fs_version through dualWrite, then hand-stale task.json (overwrite with the
  // pre-claim snapshot), then reconcile → SKIP, DB state preserved.
  const { id: projectId } = makeProject();
  const taskId = createRealTask({ projectId, title: 'Preserve Test' });

  // First scan to populate folder_path and write the initial task.json.
  await scanAll({ dryRun: false });

  // Locate the task folder.
  const dbRow0 = stmts.getTask.get(taskId);
  const project0 = stmts.getProject.get(dbRow0.project_id);
  const phaseDir0 = getPhaseDir(project0, 1);
  const taskDir0 = findTaskFolderByUuid(phaseDir0, taskId);
  expect(taskDir0).toBeTruthy();
  const taskJsonPath = path.join(taskDir0, 'task.json');
  expect(fs.existsSync(taskJsonPath)).toBe(true);

  // Capture the pre-transition task.json snapshot (status=pending, lower fs_version).
  const preClaimSnapshot = fs.readFileSync(taskJsonPath, 'utf8');
  const preClaimJson = JSON.parse(preClaimSnapshot);
  expect(preClaimJson.status).toBe('pending');
  const preClaimFsVersion = preClaimJson.fs_version ?? 0;

  // Perform a REAL claimTask() transition — this goes through dualWrite and bumps
  // fs_version by 1 in the DB (and writes the updated task.json to disk).
  const claimResult = claimTask({ taskId, actor: { id: 'test-agent' } });
  expect(claimResult.status).toBe(200);
  expect(claimResult.body.status).toBe('claimed');

  // Verify DB now has bumped fs_version (proving dualWrite ran).
  const dbAfterClaim = stmts.getTask.get(taskId);
  expect(dbAfterClaim.status).toBe('claimed');
  expect(dbAfterClaim.fs_version).toBeGreaterThan(preClaimFsVersion);
  const dbFsVersion = dbAfterClaim.fs_version;

  // Hand-stale task.json: overwrite it with the pre-claim snapshot.
  // This simulates FS lag — task.json still shows the old pending state
  // and the old (lower) fs_version, while DB is legitimately ahead.
  fs.writeFileSync(taskJsonPath, preClaimSnapshot, 'utf8');
  const staledJson = JSON.parse(fs.readFileSync(taskJsonPath, 'utf8'));
  expect(staledJson.fs_version ?? 0).toBe(preClaimFsVersion);
  expect(staledJson.status).toBe('pending');

  // Run reconcile — DB fs_version > file fs_version, so FS must NOT clobber.
  const diff = await scanAll({ dryRun: false });

  // DB value must be preserved (the legitimate transition wins).
  const rowAfter = stmts.getTask.get(taskId);
  expect(rowAfter.status).toBe('claimed');
  expect(rowAfter.fs_version).toBe(dbFsVersion);

  // The task should NOT appear in the updated list (skip, not clobber).
  const projectResult = diff.projects.find((p) => p.project_id === projectId);
  const taskEntry = projectResult?.tasks.find((t) => t.task_id === taskId);
  if (taskEntry) {
    expect(taskEntry.action).not.toBe('updated');
  }
});

// ---------------------------------------------------------------------------
// D3c — read-path unchanged: getTask/listTasks have no CORTEX_FOLDER_AUTHORITY branch
// ---------------------------------------------------------------------------

test('p4.d3c getTask is DB-direct regardless of CORTEX_FOLDER_AUTHORITY', async () => {
  const { id: projectId } = makeProject();
  const taskId = createRealTask({ projectId, title: 'Re-upsert Test' });

  // Flag OFF — baseline read
  delete process.env.CORTEX_FOLDER_AUTHORITY;
  const r1 = getTask({ taskId });
  expect(r1.status).toBe(200);
  expect(r1.body.id).toBe(taskId);
  expect(r1.body.status).toBe('pending');

  // Flag ON — must return identical result (DB-direct, no FS read)
  process.env.CORTEX_FOLDER_AUTHORITY = '1';
  const r2 = getTask({ taskId });
  expect(r2.status).toBe(200);
  expect(r2.body.id).toBe(taskId);
  expect(r2.body.status).toBe('pending');
  expect(r2.body.title).toBe(r1.body.title);
});

test('p4.d3c listTasks is DB-direct regardless of CORTEX_FOLDER_AUTHORITY', async () => {
  const { id: projectId } = makeProject();
  createRealTask({ projectId, title: 'Single Fold Path' });

  delete process.env.CORTEX_FOLDER_AUTHORITY;
  const r1 = listTasks({ query: { project_id: projectId }, actor: actor('system'), isAdmin: true });
  expect(r1.status).toBe(200);

  process.env.CORTEX_FOLDER_AUTHORITY = '1';
  const r2 = listTasks({ query: { project_id: projectId }, actor: actor('system'), isAdmin: true });
  expect(r2.status).toBe(200);
  expect(r2.body.tasks.length).toBe(r1.body.tasks.length);
});

// ROOT E — D3c route-layer read-path proof through actual task API routes.
// Asserts that CORTEX_FOLDER_AUTHORITY does not alter response shape for
// GET /v1/api/tasks/:id and GET /v1/api/tasks (the real production dispatch path).

test('p4.d3c-route GET /v1/api/tasks/:id response identical flag off/on', async () => {
  const { id: projectId } = makeProject();
  const taskId = createRealTask({ projectId, title: 'Route Read Test' });
  const adapter = makeAdapter(true);
  mountTaskRoutes(adapter);

  // Flag OFF — baseline via route dispatch
  delete process.env.CORTEX_FOLDER_AUTHORITY;
  const r1 = await adapter.dispatch('GET', `/v1/api/tasks/${taskId}`, null);
  expect(r1.status).toBe(200);
  expect(r1.body.id).toBe(taskId);
  expect(r1.body.status).toBe('pending');

  // Flag ON — route dispatch must return identical shape (DB-direct, no flag branch)
  process.env.CORTEX_FOLDER_AUTHORITY = '1';
  const r2 = await adapter.dispatch('GET', `/v1/api/tasks/${taskId}`, null);
  expect(r2.status).toBe(200);
  expect(r2.body.id).toBe(r1.body.id);
  expect(r2.body.status).toBe(r1.body.status);
  expect(r2.body.title).toBe(r1.body.title);
  // Full response shape unchanged
  expect(r2.body.project_id).toBe(r1.body.project_id);
  expect(r2.body.created_at).toBe(r1.body.created_at);
});

test('p4.d3c-route GET /v1/api/tasks list response identical flag off/on', async () => {
  const { id: projectId } = makeProject();
  const taskId = createRealTask({ projectId, title: 'Route List Test' });
  const adapter = makeAdapter(true);
  mountTaskRoutes(adapter);

  delete process.env.CORTEX_FOLDER_AUTHORITY;
  const r1 = await adapter.dispatch('GET', '/v1/api/tasks', null, { project_id: projectId });
  expect(r1.status).toBe(200);
  expect(Array.isArray(r1.body.tasks)).toBe(true);
  const t1 = r1.body.tasks.find((t) => t.id === taskId);
  expect(t1).toBeTruthy();

  process.env.CORTEX_FOLDER_AUTHORITY = '1';
  const r2 = await adapter.dispatch('GET', '/v1/api/tasks', null, { project_id: projectId });
  expect(r2.status).toBe(200);
  expect(r2.body.tasks.length).toBe(r1.body.tasks.length);
  const t2 = r2.body.tasks.find((t) => t.id === taskId);
  expect(t2).toBeTruthy();
  // Full task shape unchanged under flag
  expect(t2.status).toBe(t1.status);
  expect(t2.title).toBe(t1.title);
  expect(t2.project_id).toBe(t1.project_id);
});

test('p4.d3c-route read path unaffected when DB and task.json intentionally diverge', async () => {
  // With flag on, if DB and FS diverge (DB-injected status), GET reads DB directly
  // and returns the DB value regardless of any FS state.
  const { id: projectId } = makeProject();
  const taskId = createRealTask({ projectId, title: 'Diverge Read Test' });
  await scanAll({ dryRun: false }); // write task.json to disk

  // Inject DB drift (status='in_progress') without touching task.json
  db.prepare(`UPDATE tasks SET status = 'in_progress' WHERE id = ?`).run(taskId);

  process.env.CORTEX_FOLDER_AUTHORITY = '1';
  const adapter = makeAdapter(true);
  mountTaskRoutes(adapter);

  // GET must return the DB value (in_progress), not the FS value (pending)
  const r = await adapter.dispatch('GET', `/v1/api/tasks/${taskId}`, null);
  expect(r.status).toBe(200);
  expect(r.body.status).toBe('in_progress'); // DB-direct, not FS-read
});

// ---------------------------------------------------------------------------
// D1 — flag presence assertion (boot reconcile is unconditional; flag enables D2 only)
// ---------------------------------------------------------------------------

test('p4.d1a flag OFF: CORTEX_FOLDER_AUTHORITY absent → flag evaluates to false', async () => {
  // Boot reconcile (scanAll) runs unconditionally regardless of this flag.
  // The flag ONLY enables the D2 admin endpoint + authority declaration.
  // Here we assert the flag read: '1' is the only truthy value.
  delete process.env.CORTEX_FOLDER_AUTHORITY;
  expect(process.env.CORTEX_FOLDER_AUTHORITY === '1').toBe(false);

  // scanAll still callable directly (no flag dependency in reconciler itself)
  const { id: projectId } = makeProject();
  createRealTask({ projectId, title: 'Phase 1 Task' });
  const diff = await scanAll({ dryRun: true });
  expect(diff.totals).toBeDefined();
});

test('p4.d1b flag ON: CORTEX_FOLDER_AUTHORITY=1 flag evaluates to true (enables D2 endpoint)', async () => {
  process.env.CORTEX_FOLDER_AUTHORITY = '1';
  expect(process.env.CORTEX_FOLDER_AUTHORITY === '1').toBe(true);

  const { id: projectId } = makeProject();
  createRealTask({ projectId, title: 'Phase 2 Task' });
  // With flag ON, scanAll should run and find no drift (task.json was just written by dualWrite)
  const diff = await scanAll({ dryRun: false });
  expect(diff.totals.projects_scanned).toBeGreaterThanOrEqual(1);
});

// ---------------------------------------------------------------------------
// D2 — admin-socket-only + flag gate
// ---------------------------------------------------------------------------

test('p4.d2a flag OFF → POST /v1/api/tasks/reconcile returns 404', async () => {
  delete process.env.CORTEX_FOLDER_AUTHORITY;
  const adapter = makeAdapter(true); // isAdminSocket=true, but flag is off
  mountTaskRoutes(adapter);
  const result = await adapter.dispatch('POST', '/v1/api/tasks/reconcile', { dry_run: true });
  expect(result.status).toBe(404);
  expect(result.body.error).toBe('not_found');
});

test('p4.d2b TCP attempt → 403 admin_scope_requires_unix_socket', async () => {
  process.env.CORTEX_FOLDER_AUTHORITY = '1';
  const adapter = makeAdapter(false); // isAdminSocket=false = TCP
  mountTaskRoutes(adapter);
  const result = await adapter.dispatch('POST', '/v1/api/tasks/reconcile', { dry_run: true });
  expect(result.status).toBe(403);
  expect(result.body.error).toBe('admin_scope_requires_unix_socket');
});

test('p4.d2c flag ON + isAdminSocket → 200 + diff report shape', async () => {
  process.env.CORTEX_FOLDER_AUTHORITY = '1';
  const { id: projectId } = makeProject();
  createRealTask({ projectId, title: 'Fold Parity Task' });

  const adapter = makeAdapter(true); // isAdminSocket=true
  mountTaskRoutes(adapter);
  const result = await adapter.dispatch('POST', '/v1/api/tasks/reconcile', { dry_run: true });
  expect(result.status).toBe(200);

  // Verify diff report shape matches reconciler contract
  const body = result.body;
  expect(typeof body.scanned_at).toBe('string');
  expect(body.dry_run).toBe(true); // body.dry_run respected
  expect(Array.isArray(body.projects)).toBe(true);
  expect(typeof body.totals).toBe('object');
  expect(typeof body.totals.added).toBe('number');
  expect(typeof body.totals.updated).toBe('number');
  expect(typeof body.totals.removed).toBe('number');
  expect(typeof body.totals.projects_scanned).toBe('number');
  expect(typeof body.totals.parity_failures).toBe('number');
});

test('p4.d2d dryRun defaults to true when body.dry_run absent', async () => {
  process.env.CORTEX_FOLDER_AUTHORITY = '1';
  const { id: projectId } = makeProject();
  createRealTask({ projectId, title: 'Idempotent A' });

  const adapter = makeAdapter(true);
  mountTaskRoutes(adapter);
  // Send no body — dry_run should default to true
  const result = await adapter.dispatch('POST', '/v1/api/tasks/reconcile', null);
  expect(result.status).toBe(200);
  expect(result.body.dry_run).toBe(true);
});

test('p4.d2e dryRun=false executes live writes', async () => {
  process.env.CORTEX_FOLDER_AUTHORITY = '1';
  const { id: projectId } = makeProject();
  createRealTask({ projectId, title: 'Idempotent B' });

  const adapter = makeAdapter(true);
  mountTaskRoutes(adapter);
  const result = await adapter.dispatch('POST', '/v1/api/tasks/reconcile', { dry_run: false });
  expect(result.status).toBe(200);
  expect(result.body.dry_run).toBe(false);
});

// ---------------------------------------------------------------------------
// ROOT C — strict dry_run coercion: only boolean false disables dry-run default
// ---------------------------------------------------------------------------

test('p4.dry_run.int-zero: dry_run=0 (falsy non-boolean) → dry_run treated as true', async () => {
  process.env.CORTEX_FOLDER_AUTHORITY = '1';
  const adapter = makeAdapter(true);
  mountTaskRoutes(adapter);
  // 0 is falsy but not boolean false — must default to dry-run
  const result = await adapter.dispatch('POST', '/v1/api/tasks/reconcile', { dry_run: 0 });
  expect(result.status).toBe(200);
  expect(result.body.dry_run).toBe(true);
});

test('p4.dry_run.empty-string: dry_run="" (falsy non-boolean) → dry_run treated as true', async () => {
  process.env.CORTEX_FOLDER_AUTHORITY = '1';
  const adapter = makeAdapter(true);
  mountTaskRoutes(adapter);
  const result = await adapter.dispatch('POST', '/v1/api/tasks/reconcile', { dry_run: '' });
  expect(result.status).toBe(200);
  expect(result.body.dry_run).toBe(true);
});

test('p4.dry_run.string-false: dry_run="false" (string) → dry_run treated as true', async () => {
  process.env.CORTEX_FOLDER_AUTHORITY = '1';
  const adapter = makeAdapter(true);
  mountTaskRoutes(adapter);
  const result = await adapter.dispatch('POST', '/v1/api/tasks/reconcile', { dry_run: 'false' });
  expect(result.status).toBe(200);
  expect(result.body.dry_run).toBe(true);
});

test('p4.dry_run.null: dry_run=null → dry_run treated as true', async () => {
  process.env.CORTEX_FOLDER_AUTHORITY = '1';
  const adapter = makeAdapter(true);
  mountTaskRoutes(adapter);
  const result = await adapter.dispatch('POST', '/v1/api/tasks/reconcile', { dry_run: null });
  expect(result.status).toBe(200);
  expect(result.body.dry_run).toBe(true);
});

test('p4.dry_run.boolean-true: dry_run=true (boolean) → dry_run=true', async () => {
  process.env.CORTEX_FOLDER_AUTHORITY = '1';
  const adapter = makeAdapter(true);
  mountTaskRoutes(adapter);
  const result = await adapter.dispatch('POST', '/v1/api/tasks/reconcile', { dry_run: true });
  expect(result.status).toBe(200);
  expect(result.body.dry_run).toBe(true);
});

test('p4.dry_run.boolean-false-live: dry_run=false (boolean) → live writes (only value that disables dry-run)', async () => {
  process.env.CORTEX_FOLDER_AUTHORITY = '1';
  const { id: projectId } = makeProject();
  createRealTask({ projectId, title: 'Strict Coerce Task' });
  const adapter = makeAdapter(true);
  mountTaskRoutes(adapter);
  const result = await adapter.dispatch('POST', '/v1/api/tasks/reconcile', { dry_run: false });
  expect(result.status).toBe(200);
  expect(result.body.dry_run).toBe(false);
});

// ---------------------------------------------------------------------------
// ROOT 1 — per-project reconcile route Phase-4 gate (F1+F3)
// ---------------------------------------------------------------------------

test('p4.per-project.flag-off: POST /v1/api/tasks/reconcile/:id → 404 when flag OFF', async () => {
  delete process.env.CORTEX_FOLDER_AUTHORITY;
  const { id: projectId } = makeProject();
  const adapter = makeAdapter(true); // isAdminSocket=true, but flag is off
  mountTaskRoutes(adapter);
  const result = await adapter.dispatch('POST', `/v1/api/tasks/reconcile/${projectId}`, { dry_run: true });
  expect(result.status).toBe(404);
  expect(result.body.error).toBe('not_found');
  expect(result.body.reason).toMatch(/CORTEX_FOLDER_AUTHORITY/);
});

test('p4.per-project.flag-on-non-socket: flag ON + non-socket admin → 403', async () => {
  process.env.CORTEX_FOLDER_AUTHORITY = '1';
  const { id: projectId } = makeProject();
  const adapter = makeAdapter(false); // isAdminSocket=false (TCP)
  mountTaskRoutes(adapter);
  const result = await adapter.dispatch('POST', `/v1/api/tasks/reconcile/${projectId}`, { dry_run: true });
  expect(result.status).toBe(403);
  expect(result.body.error).toBe('admin_scope_requires_unix_socket');
});

test('p4.per-project.no-body: flag ON + socket + no body → dry_run=true (no live writes)', async () => {
  process.env.CORTEX_FOLDER_AUTHORITY = '1';
  const { id: projectId } = makeProject();
  createRealTask({ projectId, title: 'Per-Project Dry Test' });
  await scanAll({ dryRun: false }); // write task.json so reconcileProjectById has something to scan
  const adapter = makeAdapter(true);
  mountTaskRoutes(adapter);
  // No body — must default to dry_run=true (no DB writes)
  const result = await adapter.dispatch('POST', `/v1/api/tasks/reconcile/${projectId}`, null);
  expect(result.status).toBe(200);
  expect(result.body.dry_run).toBe(true);
});

test('p4.per-project.dry-run-false: flag ON + socket + dry_run:false → live writes', async () => {
  process.env.CORTEX_FOLDER_AUTHORITY = '1';
  const { id: projectId } = makeProject();
  createRealTask({ projectId, title: 'Per-Project Live Test' });
  await scanAll({ dryRun: false }); // populate task.json
  const adapter = makeAdapter(true);
  mountTaskRoutes(adapter);
  const result = await adapter.dispatch('POST', `/v1/api/tasks/reconcile/${projectId}`, { dry_run: false });
  expect(result.status).toBe(200);
  expect(result.body.dry_run).toBe(false);
});

test('p4.per-project.coerce-int-zero: dry_run=0 (non-boolean false) → dry_run=true', async () => {
  process.env.CORTEX_FOLDER_AUTHORITY = '1';
  const { id: projectId } = makeProject();
  createRealTask({ projectId, title: 'Coerce Test' });
  await scanAll({ dryRun: false });
  const adapter = makeAdapter(true);
  mountTaskRoutes(adapter);
  const result = await adapter.dispatch('POST', `/v1/api/tasks/reconcile/${projectId}`, { dry_run: 0 });
  expect(result.status).toBe(200);
  expect(result.body.dry_run).toBe(true);
});

// ---------------------------------------------------------------------------
// Operator live-recovery contract proof (F4 — run-prod.sh documented payload)
//
// Proves that the EXACT documented activation path from scripts/run-prod.sh
// (admin-socket context + {"dry_run": false} body) performs a live DB write:
// a diverged row is actually repaired (status changes in the DB). A bare POST
// (no body) must NOT change any row.
// ---------------------------------------------------------------------------

test('operator live-recovery contract: documented payload {"dry_run":false} performs live reconcile', async () => {
  // Setup: establish a clean task on disk + DB via scanAll live write.
  process.env.CORTEX_FOLDER_AUTHORITY = '1';
  const { id: projectId } = makeProject();
  const taskId = createRealTask({ projectId, title: 'Live Recovery Contract' });
  await scanAll({ dryRun: false }); // write task.json to disk; populate folder_path

  // Inject divergence: mutate DB status without touching task.json or fs_version.
  // This is the class of drift the D2 endpoint is designed to repair.
  db.prepare(`UPDATE tasks SET status = 'in_progress' WHERE id = ?`).run(taskId);
  expect(stmts.getTask.get(taskId).status).toBe('in_progress'); // confirm injection

  // Bare POST (no body) → dry_run defaults to true → no DB writes.
  const adapter = makeAdapter(true); // admin-socket context (per documented path)
  mountTaskRoutes(adapter);
  const dryResult = await adapter.dispatch('POST', '/v1/api/tasks/reconcile', null);
  expect(dryResult.status).toBe(200);
  expect(dryResult.body.dry_run).toBe(true);
  // Row must NOT be repaired by the dry-run call.
  expect(stmts.getTask.get(taskId).status).toBe('in_progress');

  // Documented live-recovery payload: admin-socket + {"dry_run": false}
  // This is the EXACT payload from scripts/run-prod.sh operator recovery section.
  const liveResult = await adapter.dispatch('POST', '/v1/api/tasks/reconcile', { dry_run: false });
  expect(liveResult.status).toBe(200);
  expect(liveResult.body.dry_run).toBe(false);

  // Proof: the row was actually repaired (status restored from task.json).
  const rowAfter = stmts.getTask.get(taskId);
  expect(rowAfter.status).toBe('pending'); // FS-win: task.json had 'pending'
  // Report must reflect the live write.
  expect(liveResult.body.totals.updated).toBeGreaterThanOrEqual(1);
});
