/**
 * Plane-transition Phase 1b tests — per-task events.jsonl append + fs_version bump.
 *
 * Covers the two additive changes to the authoritative dual-write path:
 *   TASK 1 — every state-changing transition appends EXACTLY ONE line to the
 *            task's own `events.jsonl`, byte-for-byte matching the locked 1a
 *            schema {ts,task_id,project_id,actor,event_type,from_status,
 *            to_status,data}, extending the file 1a backfilled.
 *   TASK 2 — every state-changing transition bumps tasks.fs_version by exactly
 *            1 (DB) and the value flows into the written task.json (FS), so the
 *            version-gated FS-wins reconcile (reconciler.js:253-262) is safe.
 *
 * Fresh tmpdir DB + tmpdir projects root per test. NEVER touches the live DB.
 *
 * Run with:
 *   cd <worktree> && bun test "$PWD/services/gateway/tasks/tests/transitions.events-jsonl-fsversion.test.js"
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
  createTask,
  claimTask,
  reportProgress,
  submitTask,
  requestVerification,
  approveTask,
  rejectTask,
  cancelTask,
} from '../transitions.js';
import { scanAll } from '../reconciler.js';
import { getProjectDir, getPhaseDir, findTaskFolderByUuid } from '../folders.js';
import { writeTaskJson, readTaskJson } from '../ledger.js';

// ---------------------------------------------------------------------------
// Infrastructure (mirrors transitions.dualwrite.test.js)
// ---------------------------------------------------------------------------

let ROOT;
let PROJECTS_DIR;
let db;
let stmts;

beforeEach(() => {
  resetTaskStatementsForTests();
  resetDbForTests();

  const rand = randomUUID().slice(0, 8);
  ROOT = path.join(os.tmpdir(), `cortex-1b-${process.pid}-${rand}`);
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

function makeAgent(id = `agent-${randomUUID().slice(0, 8)}`) {
  db.prepare(
    `INSERT INTO agents (id, name, kind, status) VALUES (?, ?, 'generic', 'online')`,
  ).run(id, id);
  return id;
}

function actor(id) { return { id }; }

/**
 * Create a real task via the create path (so the folder + task.json exist on
 * disk, like a backfilled task) and return its id + project context.
 */
function createRealTask({ projectId, title = 'Task 1b' }) {
  const res = createTask({
    body: { project_id: projectId, title, phase_number: 1, priority: 'high' },
    actor: actor('system'),
    isAdmin: true,
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

function taskDirFor(projectId, taskId) {
  const project = stmts.getProject.get(projectId);
  const phaseDir = getPhaseDir(project, 1);
  return findTaskFolderByUuid(phaseDir, taskId);
}

function readEvents(projectId, taskId) {
  const dir = taskDirFor(projectId, taskId);
  if (!dir) return null;
  const fp = path.join(dir, 'events.jsonl');
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const LOCKED_KEYS = [
  'ts', 'task_id', 'project_id', 'actor',
  'event_type', 'from_status', 'to_status', 'data',
];

function assertLockedShape(line, { taskId, projectId }) {
  // byte-for-byte shape: exactly the 8 locked keys, no more, no fewer.
  expect(Object.keys(line).sort()).toEqual([...LOCKED_KEYS].sort());
  expect(typeof line.ts).toBe('string');
  expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(line.task_id).toBe(taskId);
  expect(line.project_id).toBe(projectId);
  expect(typeof line.actor).toBe('string');
  expect(typeof line.event_type).toBe('string');
  // from_status / to_status are string|null
  expect(['string', 'object']).toContain(typeof line.from_status);
  expect(['string', 'object']).toContain(typeof line.to_status);
  // data always present, an object, never omitted
  expect(line.data).toBeDefined();
  expect(typeof line.data).toBe('object');
  expect(line.data).not.toBeNull();
}

function fsVersion(taskId) {
  return stmts.getTask.get(taskId).fs_version ?? 0;
}

// ---------------------------------------------------------------------------
// TASK 1 — events.jsonl append
// ---------------------------------------------------------------------------

test('1b.1 claimTask appends exactly one events.jsonl line matching the locked schema', () => {
  const { id: projectId } = makeProject();
  const agentId = makeAgent();
  const taskId = createRealTask({ projectId });

  // Task 120 landed the genesis atomicity carved out of 1b: createTask seeds
  // events.jsonl with the task_created line IN the create transaction, so the
  // file already holds exactly the genesis line here.
  const before = readEvents(projectId, taskId);
  expect(before).not.toBeNull();
  expect(before.map((e) => e.event_type)).toEqual(['task_created']);
  const beforeLen = before.length;

  const res = claimTask({ taskId, actor: actor(agentId) });
  expect(res.status).toBe(200);

  const after = readEvents(projectId, taskId);
  // EXACTLY ONE new line appended.
  expect(after.length).toBe(beforeLen + 1);

  const line = after[after.length - 1];
  assertLockedShape(line, { taskId, projectId });
  expect(line.event_type).toBe('task_claimed');
  expect(line.from_status).toBe('pending');
  expect(line.to_status).toBe('claimed');
  expect(line.actor).toBe(agentId);
  expect(line.data.assigned_to).toBe(agentId);
});

test('1b.2 events.jsonl line is byte-identical in shape to the ledger.jsonl line (same writer)', () => {
  const { id: projectId, rootPath } = makeProject();
  const agentId = makeAgent();
  const taskId = createRealTask({ projectId });

  claimTask({ taskId, actor: actor(agentId) });

  const events = readEvents(projectId, taskId);
  const claimEvent = events.find((e) => e.event_type === 'task_claimed');

  // The per-project ledger.jsonl carries the same claim line.
  const ledger = fs.readFileSync(path.join(rootPath, 'ledger.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const claimLedger = ledger.find((e) => e.event_type === 'task_claimed' && e.task_id === taskId);

  // Same object shape and same field values (the events.jsonl line extends the
  // 1a backfill seamlessly because it IS the ledger line, written per-task).
  expect(claimEvent).toEqual(claimLedger);
});

test('1b.3 a full lifecycle appends one ordered events.jsonl line per transition (no dup, no rewrite)', () => {
  const { id: projectId } = makeProject();
  const agentId = makeAgent();
  const reviewerId = makeAgent();
  const taskId = createRealTask({ projectId });

  claimTask({ taskId, actor: actor(agentId) });
  reportProgress({
    taskId, actor: actor(agentId),
    body: { status: 'in_progress', summary: 'work', files_changed: ['src/a.js'] },
  });
  for (const type of ['planning', 'context', 'decision', 'test']) {
    stmts.insertTaskJournal.run(randomUUID(), taskId, type, `${type} s`, '[]', '{}', agentId);
  }
  submitTask({ taskId, actor: actor(agentId), body: { summary: 'done', files_changed: ['src/a.js'] } });
  requestVerification({ taskId, actor: actor(agentId), body: { reviewer: reviewerId } });
  approveTask({ taskId, actor: actor(reviewerId), isAdmin: false });

  const events = readEvents(projectId, taskId);
  const types = events.map((e) => e.event_type);

  // One line per transition, in order. (reportProgress claimed→in_progress is a
  // single progressed event because the task was already claimed.) Task 120:
  // the genesis task_created line IS present — createTask seeds events.jsonl
  // in-transaction (genesis atomicity, carved from 1b and landed in 120).
  expect(types).toEqual([
    'task_created',
    'task_claimed',
    'task_progressed',
    'task_submitted',
    'task_review_requested',
    'task_approved',
  ]);

  // Ordering monotonic by ts.
  const tsList = events.map((e) => Date.parse(e.ts));
  const sorted = [...tsList].sort((a, b) => a - b);
  expect(tsList).toEqual(sorted);

  // Every line matches the locked shape.
  for (const line of events) assertLockedShape(line, { taskId, projectId });
});

test('1b.4 the audit↔events parity invariant holds (count matches per task)', () => {
  const { id: projectId } = makeProject();
  const agentId = makeAgent();
  const taskId = createRealTask({ projectId });

  claimTask({ taskId, actor: actor(agentId) });
  cancelTask({ taskId, actor: actor(agentId), body: { reason: 'stop' } });

  const events = readEvents(projectId, taskId);
  // Task 120: the genesis task_created EVENTS line lands in the same txn as
  // the task_created audit row, so FULL parity holds — no genesis exclusion.
  const audits = stmts.listAudit.all(projectId)
    .filter((a) => a.task_id === taskId);

  // events.jsonl rows == audit_log rows for the same task (parity anchor),
  // including genesis.
  expect(events.length).toBe(audits.length);
  expect(events.map((e) => e.event_type).sort())
    .toEqual(audits.map((a) => a.event_type).sort());
});

// ---------------------------------------------------------------------------
// rejectTask reject-flow — drive a real reject end-to-end and
// assert events.jsonl ↔ ledger.jsonl parity, DB ↔ task.json fs_version sync,
// and the compensated forced-failure case (BUG-A pattern).
// ---------------------------------------------------------------------------

// Drive a task to the `review` state via the real handlers so rejectTask's
// `status === 'review'` guard is satisfied. owner = agentId, reviewer = a
// distinct agent (rejectTask forbids reviewing one's own work).
function driveToReview({ projectId, ownerId, reviewerId }) {
  const taskId = createRealTask({ projectId });
  claimTask({ taskId, actor: actor(ownerId) });
  reportProgress({
    taskId, actor: actor(ownerId),
    body: { status: 'in_progress', summary: 'work', files_changed: ['src/a.js'] },
  });
  // Strict mode requires the 4 journal types before submit/review.
  for (const type of ['planning', 'context', 'decision', 'test']) {
    stmts.insertTaskJournal.run(randomUUID(), taskId, type, `${type} s`, '[]', '{}', ownerId);
  }
  submitTask({ taskId, actor: actor(ownerId), body: { summary: 'done', files_changed: ['src/a.js'] } });
  requestVerification({ taskId, actor: actor(ownerId), body: { reviewer: reviewerId } });
  expect(stmts.getTask.get(taskId).status).toBe('review');
  return taskId;
}

function countLinesAt(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).length;
}

test('1b.9 rejectTask appends exactly ONE task_rejected events line that EQUALS the ledger line, and DB fs_version == task.json fs_version', () => {
  const { id: projectId, rootPath } = makeProject();
  const ownerId = makeAgent();
  const reviewerId = makeAgent();
  const taskId = driveToReview({ projectId, ownerId, reviewerId });

  const before = readEvents(projectId, taskId);
  const beforeLen = before.length;

  const res = rejectTask({
    taskId, actor: actor(reviewerId), isAdmin: false,
    body: { reason: 'needs rework', guidance: 'fix the edge case' },
  });
  expect(res.status).toBe(200);
  expect(stmts.getTask.get(taskId).status).toBe('rejected');

  // (a) EXACTLY ONE new events.jsonl line, and it is the task_rejected line.
  const after = readEvents(projectId, taskId);
  expect(after.length).toBe(beforeLen + 1);
  const rejectEvent = after[after.length - 1];
  assertLockedShape(rejectEvent, { taskId, projectId });
  expect(rejectEvent.event_type).toBe('task_rejected');
  expect(rejectEvent.from_status).toBe('review');
  expect(rejectEvent.to_status).toBe('rejected');
  // Only one task_rejected line exists overall.
  expect(after.filter((e) => e.event_type === 'task_rejected').length).toBe(1);

  // (b) the events.jsonl line EQUALS the ledger.jsonl line (same writer).
  const ledger = fs.readFileSync(path.join(rootPath, 'ledger.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const rejectLedger = ledger.find((e) => e.event_type === 'task_rejected' && e.task_id === taskId);
  expect(rejectEvent).toEqual(rejectLedger);

  // (c) DB fs_version == task.json fs_version after the reject (synced by syncFiles).
  const dbVersion = fsVersion(taskId);
  const dir = taskDirFor(projectId, taskId);
  const tj = readTaskJson(dir);
  expect(tj).not.toBeNull();
  expect(tj.fs_version).toBe(dbVersion);
  expect(tj.status).toBe('rejected');
});

test('1b.10 rejectTask events.jsonl append failure leaves NO drift (DB stays in review, ledger restored, no new audit)', () => {
  const { id: projectId, rootPath } = makeProject();
  const ownerId = makeAgent();
  const reviewerId = makeAgent();
  const taskId = driveToReview({ projectId, ownerId, reviewerId });

  const dir = taskDirFor(projectId, taskId);
  const ledgerPath = path.join(rootPath, 'ledger.jsonl');

  // Force the SECOND append (per-task events.jsonl) inside the reject txn to
  // throw AFTER the ledger append wrote: replace events.jsonl with a directory
  // of the same name → appendFileSync hits EISDIR. The compensation must
  // truncate the phantom ledger line away and roll the DB transaction back.
  const eventsPath = path.join(dir, 'events.jsonl');
  if (fs.existsSync(eventsPath)) fs.rmSync(eventsPath, { recursive: true, force: true });
  fs.mkdirSync(eventsPath);

  // Snapshot pre-reject DB + ledger state.
  const rowBefore = stmts.getTask.get(taskId);
  const auditBefore = stmts.listAudit.all(projectId).length;
  const ledgerLinesBefore = countLinesAt(ledgerPath);
  const ledgerBytesBefore = fs.statSync(ledgerPath).size;

  const res = rejectTask({
    taskId, actor: actor(reviewerId), isAdmin: false,
    body: { reason: 'needs rework' },
  });
  // The failed FS append rolls the transaction back; rejectTask surfaces a 500.
  expect(res.status).toBe(500);

  // --- Assert ZERO drift (same invariant as BUG-A) -------------------------
  const rowAfter = stmts.getTask.get(taskId);
  expect(rowAfter.status).toBe('review');
  expect(rowAfter.status).toBe(rowBefore.status);
  expect(rowAfter.fs_version).toBe(rowBefore.fs_version);
  // No new audit row (the task_rejected audit rolled back with the txn).
  expect(stmts.listAudit.all(projectId).length).toBe(auditBefore);
  // ledger.jsonl restored to EXACT pre-append byte length — no phantom
  // task_rejected ledger line survived the failed append.
  expect(fs.statSync(ledgerPath).size).toBe(ledgerBytesBefore);
  expect(countLinesAt(ledgerPath)).toBe(ledgerLinesBefore);
});

// ---------------------------------------------------------------------------
// TASK 2 — fs_version bump
// ---------------------------------------------------------------------------

test('1b.5 each state-changing transition bumps tasks.fs_version by exactly 1', () => {
  const { id: projectId } = makeProject();
  const agentId = makeAgent();
  const taskId = createRealTask({ projectId });

  const v0 = fsVersion(taskId);

  claimTask({ taskId, actor: actor(agentId) });
  const v1 = fsVersion(taskId);
  expect(v1).toBe(v0 + 1);

  reportProgress({
    taskId, actor: actor(agentId),
    body: { status: 'in_progress', summary: 'work', files_changed: ['src/a.js'] },
  });
  const v2 = fsVersion(taskId);
  expect(v2).toBe(v1 + 1);

  for (const type of ['planning', 'context', 'decision', 'test']) {
    stmts.insertTaskJournal.run(randomUUID(), taskId, type, `${type} s`, '[]', '{}', agentId);
  }
  submitTask({ taskId, actor: actor(agentId), body: { summary: 'done', files_changed: ['src/a.js'] } });
  const v3 = fsVersion(taskId);
  expect(v3).toBe(v2 + 1);
});

test('1b.6 the bumped fs_version flows into the written task.json (DB and FS consistent)', () => {
  const { id: projectId } = makeProject();
  const agentId = makeAgent();
  const taskId = createRealTask({ projectId });

  claimTask({ taskId, actor: actor(agentId) });

  const dbVersion = fsVersion(taskId);
  expect(dbVersion).toBeGreaterThan(0);

  const dir = taskDirFor(projectId, taskId);
  const tj = readTaskJson(dir);
  expect(tj).not.toBeNull();
  // task.json carries the same fs_version as the DB row.
  expect(tj.fs_version).toBe(dbVersion);
});

test('1b.7 reconcile honors the bumped fs_version: FS wins when task.json.fs_version >= DB', async () => {
  const { id: projectId } = makeProject();
  const agentId = makeAgent();
  const taskId = createRealTask({ projectId });
  claimTask({ taskId, actor: actor(agentId) });

  const dir = taskDirFor(projectId, taskId);
  const dbVersion = fsVersion(taskId);

  // Operator edits task.json: change a comparable field AND bump fs_version
  // ABOVE the DB version → FS must win on reconcile.
  const tj = readTaskJson(dir);
  tj.title = 'FS-edited title';
  tj.fs_version = dbVersion + 5;
  writeTaskJson(dir, tj);

  const report = await scanAll({ dryRun: false });
  expect(report).toBeDefined();

  // FS-wins: the DB row now reflects the FS edit.
  expect(stmts.getTask.get(taskId).title).toBe('FS-edited title');
});

test('1b.8 reconcile honors fs_version: FS is correctly SKIPPED when DB is strictly ahead', async () => {
  const { id: projectId } = makeProject();
  const agentId = makeAgent();
  const taskId = createRealTask({ projectId });
  claimTask({ taskId, actor: actor(agentId) });

  const dir = taskDirFor(projectId, taskId);
  const dbVersion = fsVersion(taskId);

  // Operator edits task.json title but leaves fs_version BELOW the DB version
  // (simulating a stale folder write) → reconcile must IGNORE the FS edit.
  const tj = readTaskJson(dir);
  tj.title = 'Stale FS title that must be ignored';
  tj.fs_version = dbVersion - 1; // strictly behind
  writeTaskJson(dir, tj);

  const dbTitleBefore = stmts.getTask.get(taskId).title;
  await scanAll({ dryRun: false });

  // DB title unchanged — the stale FS edit was skipped.
  expect(stmts.getTask.get(taskId).title).toBe(dbTitleBefore);
  expect(stmts.getTask.get(taskId).title).not.toBe('Stale FS title that must be ignored');
});
