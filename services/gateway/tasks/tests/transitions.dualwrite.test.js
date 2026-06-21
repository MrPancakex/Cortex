/**
 * Dual-write tests for transitions.js — Slice A Phase 6.
 *
 * Each test runs against a fresh tmpdir DB + tmpdir projects root.
 * NEVER touches $CORTEX_HOME/state/cortex.db.
 *
 * Run with:
 *   cd $CORTEX_HOME && bun test services/gateway/tasks/tests/transitions.dualwrite.test.js
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
  resumeTask,
  reportProgress,
  submitTask,
  requestVerification,
  approveTask,
  rejectTask,
  updateTask,
  cancelTask,
  failTask,
  releaseTask,
  reassignTask,
  commentTask,
  reopenTask,
  requestTaskDelete,
  approveTaskDelete,
  denyTaskDelete,
} from '../transitions.js';
import { appendLedger } from '../ledger.js';

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

let ROOT;
let PROJECTS_DIR;
let db;
let stmts;

beforeEach(() => {
  resetTaskStatementsForTests();
  resetDbForTests();

  const rand = randomUUID().slice(0, 8);
  ROOT = path.join(os.tmpdir(), `cortex-dualwrite-${process.pid}-${rand}`);
  PROJECTS_DIR = path.join(ROOT, 'projects');
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });

  process.env.CORTEX_DB_PATH = path.join(ROOT, 'test.db');
  process.env.CORTEX_PROJECTS_DIR = PROJECTS_DIR;

  db = getDb({ path: process.env.CORTEX_DB_PATH });
  runMigrations();
  stmts = getTaskStatements();
});

afterEach(() => {
  // Best-effort chmod restore for tests that made dirs unwritable.
  try { fs.chmodSync(PROJECTS_DIR, 0o755); } catch (_) { void _; }
  try {
    const entries = fs.readdirSync(PROJECTS_DIR);
    for (const entry of entries) {
      try { fs.chmodSync(path.join(PROJECTS_DIR, entry), 0o755); } catch (_) { void _; }
    }
  } catch (_) { void _; }

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

function readLedger(rootPath) {
  const fp = path.join(rootPath, 'ledger.jsonl');
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readAuditLog(projectId) {
  return stmts.listAudit.all(projectId);
}

function getTaskRow(taskId) {
  return stmts.getTask.get(taskId);
}

/** Seed a task row directly, bypassing transitions. */
function seedTask({ projectId, phaseId, status = 'pending', assignedTo = null, title = 'Test task' }) {
  const taskId = randomUUID();
  db.prepare(`
    INSERT INTO tasks
      (id, project_id, phase_id, title, description, status, priority,
       assigned_to, created_by, tags, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, '', ?, 'medium', ?, 'system', '[]', '{}',
            datetime('now'), datetime('now'))
  `).run(taskId, projectId, phaseId, title, status, assignedTo);
  return taskId;
}

/** Insert journal entries required for submitTask + requestVerification. */
function seedJournal(taskId, actorId) {
  for (const type of ['planning', 'context', 'test']) {
    stmts.insertTaskJournal.run(
      randomUUID(), taskId, type, `${type} summary`,
      '[]', '{}', actorId,
    );
  }
}

/** Insert a progress_report with files so submitTask's fileProgressCount check passes. */
function seedProgress(taskId, actorId) {
  stmts.insertProgress.run(
    randomUUID(), taskId, actorId, 'in_progress', 0,
    'some work', JSON.stringify({ files_changed: ['src/index.js'], stub_detected: false }),
  );
}

// ---------------------------------------------------------------------------
// Test 1: createTask — task_created event
// ---------------------------------------------------------------------------

test('1a. createTask writes audit_log + ledger.jsonl with event_type=task_created', () => {
  const { id: projectId, phaseId, rootPath } = makeProject();

  const res = createTask({
    body: { project_id: projectId, title: 'New task', phase_number: 1, priority: 'high' },
    actor: actor('system'),
    isAdmin: true,
  });
  expect(res.status).toBe(201);
  const taskId = res.body.id;

  const audits = readAuditLog(projectId);
  expect(audits).toHaveLength(1);
  expect(audits[0].event_type).toBe('task_created');
  expect(audits[0].task_id).toBe(taskId);
  expect(audits[0].actor).toBe('system');

  const lines = readLedger(rootPath);
  expect(lines).toHaveLength(1);
  expect(lines[0].event_type).toBe('task_created');
  expect(lines[0].from_status).toBeNull();
  expect(lines[0].to_status).toBe('pending');
  expect(lines[0].data.title).toBe('New task');
});

// ---------------------------------------------------------------------------
// Test 2: claimTask — task_claimed event
// ---------------------------------------------------------------------------

test('2. claimTask writes audit_log + ledger.jsonl with event_type=task_claimed', () => {
  const { id: projectId, phaseId, rootPath } = makeProject();
  const agentId = makeAgent();
  const taskId = seedTask({ projectId, phaseId, status: 'pending' });

  const res = claimTask({ taskId, actor: actor(agentId) });
  expect(res.status).toBe(200);

  const audits = readAuditLog(projectId);
  expect(audits).toHaveLength(1);
  expect(audits[0].event_type).toBe('task_claimed');
  expect(audits[0].task_id).toBe(taskId);
  expect(audits[0].actor).toBe(agentId);

  const lines = readLedger(rootPath);
  expect(lines).toHaveLength(1);
  expect(lines[0].event_type).toBe('task_claimed');
  expect(lines[0].from_status).toBe('pending');
  expect(lines[0].to_status).toBe('claimed');
  expect(lines[0].data.assigned_to).toBe(agentId);

  // task row updated correctly
  expect(getTaskRow(taskId).status).toBe('claimed');
  expect(getTaskRow(taskId).assigned_to).toBe(agentId);
});

// ---------------------------------------------------------------------------
// Test 3: resumeTask (from claimed) — task_resumed event
// ---------------------------------------------------------------------------

test('3. resumeTask (claimed→in_progress) writes audit_log + ledger', () => {
  const { id: projectId, phaseId, rootPath } = makeProject();
  const agentId = makeAgent();
  const taskId = seedTask({ projectId, phaseId, status: 'claimed', assignedTo: agentId });

  const res = resumeTask({ taskId, actor: actor(agentId) });
  expect(res.status).toBe(200);

  const audits = readAuditLog(projectId);
  expect(audits).toHaveLength(1);
  expect(audits[0].event_type).toBe('task_resumed');

  const lines = readLedger(rootPath);
  expect(lines).toHaveLength(1);
  expect(lines[0].event_type).toBe('task_resumed');
  expect(lines[0].from_status).toBe('claimed');
  expect(lines[0].to_status).toBe('in_progress');
  expect(JSON.parse(audits[0].payload).from).toBe('claimed');

  expect(getTaskRow(taskId).status).toBe('in_progress');
});

// ---------------------------------------------------------------------------
// Test 4: resumeTask (from rejected) — task_resumed event
// ---------------------------------------------------------------------------

test('4. resumeTask (rejected→in_progress) writes audit_log + ledger', () => {
  const { id: projectId, phaseId, rootPath } = makeProject();
  const agentId = makeAgent();
  const taskId = seedTask({ projectId, phaseId, status: 'rejected', assignedTo: agentId });

  const res = resumeTask({ taskId, actor: actor(agentId) });
  expect(res.status).toBe(200);

  const lines = readLedger(rootPath);
  expect(lines).toHaveLength(1);
  expect(lines[0].from_status).toBe('rejected');
  expect(lines[0].to_status).toBe('in_progress');
  expect(lines[0].event_type).toBe('task_resumed');
});

// ---------------------------------------------------------------------------
// Test 5: reportProgress — task_progressed event
// ---------------------------------------------------------------------------

test('5. reportProgress writes audit_log + ledger with event_type=task_progressed', () => {
  const { id: projectId, phaseId, rootPath } = makeProject();
  const agentId = makeAgent();
  const taskId = seedTask({ projectId, phaseId, status: 'in_progress', assignedTo: agentId });

  const res = reportProgress({
    taskId,
    actor: actor(agentId),
    body: {
      status: 'in_progress',
      summary: 'Working on it',
      files_changed: ['src/foo.js'],
    },
  });
  expect(res.status).toBe(200);

  const audits = readAuditLog(projectId);
  expect(audits).toHaveLength(1);
  expect(audits[0].event_type).toBe('task_progressed');

  const lines = readLedger(rootPath);
  expect(lines).toHaveLength(1);
  expect(lines[0].event_type).toBe('task_progressed');
  expect(lines[0].from_status).toBe('in_progress');
  expect(lines[0].to_status).toBe('in_progress');
  expect(lines[0].data.files_changed_count).toBe(1);
});

// ---------------------------------------------------------------------------
// Test 6: reportProgress auto-advance (claimed→in_progress)
// ---------------------------------------------------------------------------

test('6. reportProgress auto-advance from claimed writes from_status=claimed', () => {
  const { id: projectId, phaseId, rootPath } = makeProject();
  const agentId = makeAgent();
  const taskId = seedTask({ projectId, phaseId, status: 'claimed', assignedTo: agentId });

  const res = reportProgress({
    taskId,
    actor: actor(agentId),
    body: {
      status: 'in_progress',
      summary: 'First push',
      files_changed: ['src/bar.js'],
    },
  });
  expect(res.status).toBe(200);

  const lines = readLedger(rootPath);
  expect(lines).toHaveLength(1);
  expect(lines[0].from_status).toBe('claimed');
  expect(lines[0].to_status).toBe('in_progress');
});

// ---------------------------------------------------------------------------
// Test 7: submitTask — task_submitted event
// ---------------------------------------------------------------------------

test('7. submitTask writes audit_log + ledger with event_type=task_submitted', () => {
  const { id: projectId, phaseId, rootPath } = makeProject();
  const agentId = makeAgent();
  const taskId = seedTask({ projectId, phaseId, status: 'in_progress', assignedTo: agentId });
  seedJournal(taskId, agentId);
  seedProgress(taskId, agentId);

  const res = submitTask({
    taskId,
    actor: actor(agentId),
    body: {
      summary: 'All done',
      files_changed: ['src/index.js'],
    },
  });
  expect(res.status).toBe(200);

  const audits = readAuditLog(projectId);
  expect(audits).toHaveLength(1);
  expect(audits[0].event_type).toBe('task_submitted');

  const lines = readLedger(rootPath);
  expect(lines).toHaveLength(1);
  expect(lines[0].event_type).toBe('task_submitted');
  expect(lines[0].from_status).toBe('in_progress');
  expect(lines[0].to_status).toBe('submitted');

  expect(getTaskRow(taskId).status).toBe('submitted');
});

// ---------------------------------------------------------------------------
// Test 8: requestVerification — task_review_requested event
// ---------------------------------------------------------------------------

test('8. requestVerification writes audit_log + ledger with event_type=task_review_requested', () => {
  const { id: projectId, phaseId, rootPath } = makeProject();
  const agentId = makeAgent();
  const reviewerId = makeAgent();
  const taskId = seedTask({ projectId, phaseId, status: 'submitted', assignedTo: agentId });
  // strict journal requires planning + context + decision + test
  for (const type of ['planning', 'context', 'decision', 'test']) {
    stmts.insertTaskJournal.run(
      randomUUID(), taskId, type, `${type} summary`, '[]', '{}', agentId,
    );
  }

  const res = requestVerification({
    taskId,
    actor: actor(agentId),
    body: { reviewer: reviewerId },
  });
  expect(res.status).toBe(200);

  const audits = readAuditLog(projectId);
  expect(audits).toHaveLength(1);
  expect(audits[0].event_type).toBe('task_review_requested');

  const lines = readLedger(rootPath);
  expect(lines).toHaveLength(1);
  expect(lines[0].event_type).toBe('task_review_requested');
  expect(lines[0].from_status).toBe('submitted');
  expect(lines[0].to_status).toBe('review');
  expect(lines[0].data.reviewer).toBe(reviewerId);
});

test('8b. requestVerification allows the named reviewer to pull a submitted task into review', () => {
  const { id: projectId, phaseId, rootPath } = makeProject();
  const agentId = makeAgent();
  const reviewerId = makeAgent();
  const taskId = seedTask({ projectId, phaseId, status: 'submitted', assignedTo: agentId });
  for (const type of ['planning', 'context', 'decision', 'test']) {
    stmts.insertTaskJournal.run(
      randomUUID(), taskId, type, `${type} summary`, '[]', '{}', agentId,
    );
  }

  const res = requestVerification({
    taskId,
    actor: actor(reviewerId),
    body: { reviewer: reviewerId },
  });
  expect(res.status).toBe(200);

  const lines = readLedger(rootPath);
  expect(lines).toHaveLength(1);
  expect(lines[0].event_type).toBe('task_review_requested');
  expect(lines[0].data.reviewer).toBe(reviewerId);
  expect(getTaskRow(taskId).status).toBe('review');
});

// ---------------------------------------------------------------------------
// Test 9: approveTask — task_approved event
// ---------------------------------------------------------------------------

test('9. approveTask writes audit_log + ledger with event_type=task_approved', () => {
  const { id: projectId, phaseId, rootPath } = makeProject();
  const agentId = makeAgent();
  const reviewerId = makeAgent();
  const taskId = seedTask({ projectId, phaseId, status: 'review', assignedTo: agentId });
  // set reviewer_agent in metadata
  db.prepare(`UPDATE tasks SET metadata = json_set(COALESCE(metadata,'{}'), '$.reviewer_agent', ?) WHERE id = ?`)
    .run(reviewerId, taskId);

  const res = approveTask({ taskId, actor: actor(reviewerId), isAdmin: false });
  expect(res.status).toBe(200);

  const audits = readAuditLog(projectId);
  expect(audits).toHaveLength(1);
  expect(audits[0].event_type).toBe('task_approved');

  const lines = readLedger(rootPath);
  expect(lines).toHaveLength(1);
  expect(lines[0].event_type).toBe('task_approved');
  expect(lines[0].from_status).toBe('review');
  expect(lines[0].to_status).toBe('approved');

  expect(getTaskRow(taskId).status).toBe('approved');
});

// ---------------------------------------------------------------------------
// Test 10: rejectTask — task_rejected event
// ---------------------------------------------------------------------------

test('10. rejectTask writes audit_log + ledger with event_type=task_rejected', () => {
  const { id: projectId, phaseId, rootPath } = makeProject();
  const agentId = makeAgent();
  const reviewerId = makeAgent();
  const taskId = seedTask({ projectId, phaseId, status: 'review', assignedTo: agentId });
  db.prepare(`UPDATE tasks SET metadata = json_set(COALESCE(metadata,'{}'), '$.reviewer_agent', ?) WHERE id = ?`)
    .run(reviewerId, taskId);

  const res = rejectTask({
    taskId,
    actor: actor(reviewerId),
    body: { reason: 'Not good enough' },
  });
  expect(res.status).toBe(200);

  const audits = readAuditLog(projectId);
  expect(audits).toHaveLength(1);
  expect(audits[0].event_type).toBe('task_rejected');

  const lines = readLedger(rootPath);
  expect(lines).toHaveLength(1);
  expect(lines[0].event_type).toBe('task_rejected');
  expect(lines[0].from_status).toBe('review');
  expect(lines[0].to_status).toBe('rejected');
  expect(lines[0].data.reason).toBe('Not good enough');

  expect(getTaskRow(taskId).status).toBe('rejected');
});

// ---------------------------------------------------------------------------
// Test 11: updateTask — task_updated event
// ---------------------------------------------------------------------------

test('11. updateTask writes audit_log + ledger with event_type=task_updated', () => {
  const { id: projectId, phaseId, rootPath } = makeProject();
  const agentId = makeAgent();
  const taskId = seedTask({ projectId, phaseId, status: 'in_progress', assignedTo: agentId });

  const res = updateTask({
    taskId,
    actor: actor(agentId),
    body: { title: 'Updated title' },
  });
  expect(res.status).toBe(200);

  const audits = readAuditLog(projectId);
  expect(audits).toHaveLength(1);
  expect(audits[0].event_type).toBe('task_updated');

  const lines = readLedger(rootPath);
  expect(lines).toHaveLength(1);
  expect(lines[0].event_type).toBe('task_updated');
  // status unchanged
  expect(lines[0].from_status).toBe('in_progress');
  expect(lines[0].to_status).toBe('in_progress');
  expect(lines[0].data.fields_changed).toContain('title');

  expect(getTaskRow(taskId).title).toBe('Updated title');
});

// ---------------------------------------------------------------------------
// Test 12: cancelTask — task_cancelled event
// ---------------------------------------------------------------------------

test('12. cancelTask writes audit_log + ledger with event_type=task_cancelled', () => {
  const { id: projectId, phaseId, rootPath } = makeProject();
  const agentId = makeAgent();
  const taskId = seedTask({ projectId, phaseId, status: 'in_progress', assignedTo: agentId });

  const res = cancelTask({
    taskId,
    actor: actor(agentId),
    body: { reason: 'No longer needed' },
  });
  expect(res.status).toBe(200);

  const audits = readAuditLog(projectId);
  expect(audits).toHaveLength(1);
  expect(audits[0].event_type).toBe('task_cancelled');

  const lines = readLedger(rootPath);
  expect(lines).toHaveLength(1);
  expect(lines[0].event_type).toBe('task_cancelled');
  expect(lines[0].from_status).toBe('in_progress');
  expect(lines[0].to_status).toBe('cancelled');

  expect(getTaskRow(taskId).status).toBe('cancelled');
});

// ---------------------------------------------------------------------------
// Test 13: failTask — task_failed event
// ---------------------------------------------------------------------------

test('13. failTask writes audit_log + ledger with event_type=task_failed', () => {
  const { id: projectId, phaseId, rootPath } = makeProject();
  const agentId = makeAgent();
  const taskId = seedTask({ projectId, phaseId, status: 'in_progress', assignedTo: agentId });

  const res = failTask({
    taskId,
    actor: actor(agentId),
    body: { reason: 'Unrecoverable error' },
  });
  expect(res.status).toBe(200);

  const audits = readAuditLog(projectId);
  expect(audits).toHaveLength(1);
  expect(audits[0].event_type).toBe('task_failed');

  const lines = readLedger(rootPath);
  expect(lines).toHaveLength(1);
  expect(lines[0].event_type).toBe('task_failed');
  expect(lines[0].to_status).toBe('failed');

  expect(getTaskRow(taskId).status).toBe('failed');
});

// ---------------------------------------------------------------------------
// Test 14: releaseTask — task_released event
// ---------------------------------------------------------------------------

test('14. releaseTask writes audit_log + ledger with event_type=task_released', () => {
  const { id: projectId, phaseId, rootPath } = makeProject();
  const agentId = makeAgent();
  const taskId = seedTask({ projectId, phaseId, status: 'claimed', assignedTo: agentId });

  const res = releaseTask({ taskId, actor: actor(agentId), body: { reason: 'giving up' } });
  expect(res.status).toBe(200);

  const audits = readAuditLog(projectId);
  expect(audits).toHaveLength(1);
  expect(audits[0].event_type).toBe('task_released');

  const lines = readLedger(rootPath);
  expect(lines).toHaveLength(1);
  expect(lines[0].event_type).toBe('task_released');
  expect(lines[0].from_status).toBe('claimed');
  expect(lines[0].to_status).toBe('pending');

  expect(getTaskRow(taskId).status).toBe('pending');
});

test('14b. releaseTask configured reviewer-agent force clears stale review ownership', () => {
  const { id: projectId, phaseId, rootPath } = makeProject();
  const agentId = makeAgent();
  const reviewerId = makeAgent();
  const taskId = seedTask({ projectId, phaseId, status: 'review', assignedTo: agentId });
  db.prepare(
    `UPDATE tasks SET metadata = json_set(COALESCE(metadata,'{}'), '$.reviewer_agent', ?) WHERE id = ?`,
  ).run(reviewerId, taskId);

  const denied = releaseTask({ taskId, actor: actor(agentId), body: { reason: 'stale review' } });
  expect(denied.status).toBe(409);
  expect(denied.body.error).toBe('not_releasable');

  const prevForceAgent = process.env.CORTEX_FORCE_RELEASE_AGENT;
  process.env.CORTEX_FORCE_RELEASE_AGENT = 'orion';
  const res = releaseTask({
    taskId,
    actor: actor('orion'),
    body: { reason: 'operator cleanup', force: true },
  });
  process.env.CORTEX_FORCE_RELEASE_AGENT = prevForceAgent ?? '';
  expect(res.status).toBe(200);

  const row = getTaskRow(taskId);
  expect(row.status).toBe('pending');
  expect(row.assigned_to).toBeNull();
  expect(JSON.parse(row.metadata).reviewer_agent).toBeUndefined();

  const audits = readAuditLog(projectId);
  expect(audits).toHaveLength(1);
  expect(audits[0].event_type).toBe('task_released');

  const lines = readLedger(rootPath);
  expect(lines).toHaveLength(1);
  expect(lines[0].from_status).toBe('review');
  expect(lines[0].to_status).toBe('pending');
});

// ---------------------------------------------------------------------------
// Test 15: reassignTask — task_reassigned event
// ---------------------------------------------------------------------------

test('15. reassignTask writes audit_log + ledger with event_type=task_reassigned', () => {
  const { id: projectId, phaseId, rootPath } = makeProject();
  const agentA = makeAgent();
  const agentB = makeAgent();
  const taskId = seedTask({ projectId, phaseId, status: 'in_progress', assignedTo: agentA });

  const res = reassignTask({
    taskId,
    actor: actor('admin'),
    body: { new_agent: agentB },
    isAdmin: true,
  });
  expect(res.status).toBe(200);

  const audits = readAuditLog(projectId);
  expect(audits).toHaveLength(1);
  expect(audits[0].event_type).toBe('task_reassigned');

  const lines = readLedger(rootPath);
  expect(lines).toHaveLength(1);
  expect(lines[0].event_type).toBe('task_reassigned');
  expect(lines[0].data.new_agent).toBe(agentB);
  expect(lines[0].data.previous_agent).toBe(agentA);

  expect(getTaskRow(taskId).assigned_to).toBe(agentB);
});

// ---------------------------------------------------------------------------
// Test 16: commentTask — task_commented event
// ---------------------------------------------------------------------------

test('16. commentTask writes audit_log + ledger with event_type=task_commented', () => {
  const { id: projectId, phaseId, rootPath } = makeProject();
  const agentId = makeAgent();
  const taskId = seedTask({ projectId, phaseId, status: 'in_progress', assignedTo: agentId });

  const res = commentTask({
    taskId,
    actor: actor(agentId),
    body: { comment: 'Looking good so far!' },
  });
  expect(res.status).toBe(201);

  const audits = readAuditLog(projectId);
  expect(audits).toHaveLength(1);
  expect(audits[0].event_type).toBe('task_commented');

  const lines = readLedger(rootPath);
  expect(lines).toHaveLength(1);
  expect(lines[0].event_type).toBe('task_commented');
  // status unchanged
  expect(lines[0].from_status).toBe('in_progress');
  expect(lines[0].to_status).toBe('in_progress');
  expect(lines[0].data.author).toBe(agentId);
  expect(lines[0].data.comment_length).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// Test 17: reopenTask — task_reopened event
// ---------------------------------------------------------------------------

test('17. reopenTask writes audit_log + ledger with event_type=task_reopened', () => {
  const { id: projectId, phaseId, rootPath } = makeProject();
  const agentId = makeAgent();
  const taskId = seedTask({ projectId, phaseId, status: 'rejected', assignedTo: agentId });

  const res = reopenTask({
    taskId,
    actor: actor(agentId),
    body: { reason: 'Let me try again' },
  });
  expect(res.status).toBe(200);

  const audits = readAuditLog(projectId);
  expect(audits).toHaveLength(1);
  expect(audits[0].event_type).toBe('task_reopened');

  const lines = readLedger(rootPath);
  expect(lines).toHaveLength(1);
  expect(lines[0].event_type).toBe('task_reopened');
  expect(lines[0].from_status).toBe('rejected');
  expect(lines[0].to_status).toBe('pending');
  expect(lines[0].data.previous_status).toBe('rejected');

  expect(getTaskRow(taskId).status).toBe('pending');
});

// ---------------------------------------------------------------------------
// Test 18: requestTaskDelete — task_delete_requested event
// ---------------------------------------------------------------------------

test('18. requestTaskDelete writes audit_log + ledger', () => {
  const { id: projectId, phaseId, rootPath } = makeProject();
  const agentId = makeAgent();
  const taskId = seedTask({ projectId, phaseId, status: 'pending', assignedTo: agentId });

  const res = requestTaskDelete({ taskId, actor: actor(agentId), isAdmin: true });
  expect(res.status).toBe(200);

  const audits = readAuditLog(projectId);
  expect(audits).toHaveLength(1);
  expect(audits[0].event_type).toBe('task_delete_requested');

  const lines = readLedger(rootPath);
  expect(lines).toHaveLength(1);
  expect(lines[0].event_type).toBe('task_delete_requested');
});

// ---------------------------------------------------------------------------
// Test 19: approveTaskDelete — task_deleted event
// ---------------------------------------------------------------------------

test('19. approveTaskDelete writes audit_log + ledger with event_type=task_deleted', () => {
  const { id: projectId, phaseId, rootPath } = makeProject();
  const agentId = makeAgent();
  const taskId = seedTask({ projectId, phaseId, status: 'pending', assignedTo: agentId });
  // stamp a delete_requested_at in metadata
  db.prepare(`UPDATE tasks SET metadata = json_set(COALESCE(metadata,'{}'), '$.delete_requested_at', ?) WHERE id = ?`)
    .run(new Date().toISOString(), taskId);

  const res = approveTaskDelete({ taskId, actor: actor('admin'), isAdmin: true });
  expect(res.status).toBe(200);

  // audit_log rows are CASCADE-deleted with the task row — so 0 rows remain.
  // Verify via ledger.jsonl (append-only, not cascade-deleted) instead.
  const lines = readLedger(rootPath);
  expect(lines).toHaveLength(1);
  expect(lines[0].event_type).toBe('task_deleted');

  // Row should be gone
  expect(getTaskRow(taskId)).toBeNull();
});

// ---------------------------------------------------------------------------
// Test 20: denyTaskDelete — task_delete_denied event
// ---------------------------------------------------------------------------

test('20. denyTaskDelete writes audit_log + ledger with event_type=task_delete_denied', () => {
  const { id: projectId, phaseId, rootPath } = makeProject();
  const agentId = makeAgent();
  const taskId = seedTask({ projectId, phaseId, status: 'pending', assignedTo: agentId });
  db.prepare(`UPDATE tasks SET metadata = json_set(COALESCE(metadata,'{}'), '$.delete_requested_at', ?) WHERE id = ?`)
    .run(new Date().toISOString(), taskId);

  const res = denyTaskDelete({ taskId, actor: actor('admin'), isAdmin: true });
  expect(res.status).toBe(200);

  const audits = readAuditLog(projectId);
  expect(audits).toHaveLength(1);
  expect(audits[0].event_type).toBe('task_delete_denied');

  const lines = readLedger(rootPath);
  expect(lines).toHaveLength(1);
  expect(lines[0].event_type).toBe('task_delete_denied');

  // Row remains
  expect(getTaskRow(taskId)).not.toBeNull();
});

// ---------------------------------------------------------------------------
// Test 21: task.json created by syncFiles after createTask
// ---------------------------------------------------------------------------

test('21. task.json exists in task folder after createTask', () => {
  const { id: projectId, phaseId, rootPath } = makeProject();

  const res = createTask({
    body: { project_id: projectId, title: 'JSON task', phase_number: 1 },
    actor: actor('system'),
    isAdmin: true,
  });
  expect(res.status).toBe(201);
  const taskId = res.body.id;

  // Find the task folder
  const phaseDir = path.join(rootPath, 'tasks', 'phase-1');
  const entries = fs.existsSync(phaseDir) ? fs.readdirSync(phaseDir) : [];
  const taskDir = entries.map((e) => path.join(phaseDir, e)).find((d) => {
    try { return fs.statSync(d).isDirectory(); } catch (_) { return false; }
  });
  expect(taskDir).toBeDefined();
  const taskJson = JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8'));
  expect(taskJson.id).toBe(taskId);
  expect(taskJson.status).toBe('pending');
});

// ---------------------------------------------------------------------------
// Test 22: Transaction rollback on appendLedger failure (EPERM on project dir)
// ---------------------------------------------------------------------------

test('22. appendLedger failure rolls back task mutation and audit_log', () => {
  const { id: projectId, phaseId, rootPath } = makeProject();
  const agentId = makeAgent();
  const taskId = seedTask({ projectId, phaseId, status: 'pending' });

  // Make the project dir unwritable — ledger.jsonl append will fail
  fs.chmodSync(rootPath, 0o555);

  let threw = false;
  try {
    claimTask({ taskId, actor: actor(agentId) });
  } catch (err) {
    threw = true;
  }

  // Restore permissions so afterEach cleanup works
  fs.chmodSync(rootPath, 0o755);

  // The transition either threw or returned a 500; the task must NOT be claimed
  const taskRow = getTaskRow(taskId);
  if (taskRow) {
    // Row still exists — status must be unchanged
    expect(taskRow.status).toBe('pending');
  }
  // audit_log must have no rows
  expect(readAuditLog(projectId)).toHaveLength(0);
  // ledger.jsonl must not have any lines (either empty or nonexistent)
  expect(readLedger(rootPath)).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Test 23: State guard rollback (wrong from-status)
// ---------------------------------------------------------------------------

test('23. submitTask on non-in_progress task returns 409, no audit/ledger', () => {
  const { id: projectId, phaseId, rootPath } = makeProject();
  const agentId = makeAgent();
  // Task is 'claimed', not 'in_progress'
  const taskId = seedTask({ projectId, phaseId, status: 'claimed', assignedTo: agentId });
  seedJournal(taskId, agentId);
  seedProgress(taskId, agentId);

  const res = submitTask({
    taskId,
    actor: actor(agentId),
    body: { summary: 'Done!', files_changed: ['src/index.js'] },
  });
  // submitTask checks task.status !== 'in_progress' BEFORE the mutateStmt, so it 409s early
  expect(res.status).toBe(409);

  // No audit or ledger rows
  expect(readAuditLog(projectId)).toHaveLength(0);
  expect(readLedger(rootPath)).toHaveLength(0);
  expect(getTaskRow(taskId).status).toBe('claimed');
});

// ---------------------------------------------------------------------------
// Test 24: claimTask state guard — already claimed task
// ---------------------------------------------------------------------------

test('24. claimTask state guard: claiming an already-claimed task returns 409, no audit/ledger', () => {
  const { id: projectId, phaseId, rootPath } = makeProject();
  const agentId = makeAgent();
  const agentB = makeAgent();
  const taskId = seedTask({ projectId, phaseId, status: 'claimed', assignedTo: agentId });

  const res = claimTask({ taskId, actor: actor(agentB) });
  expect(res.status).toBe(409);

  expect(readAuditLog(projectId)).toHaveLength(0);
  expect(readLedger(rootPath)).toHaveLength(0);
  expect(getTaskRow(taskId).status).toBe('claimed');
});

// ---------------------------------------------------------------------------
// Test 25: syncFiles is best-effort — task.json failure doesn't break transition
// ---------------------------------------------------------------------------

test('25. syncFiles task.json failure is swallowed; audit+ledger writes still succeed', () => {
  const { id: projectId, phaseId, rootPath } = makeProject();
  const agentId = makeAgent();

  // Create a task first so there's a folder on disk
  const res = createTask({
    body: { project_id: projectId, title: 'Swallow test', phase_number: 1 },
    actor: actor('system'),
    isAdmin: true,
  });
  expect(res.status).toBe(201);
  const taskId = res.body.id;

  // Make the phase dir unwritable so task.json can't be written by syncFiles
  const phaseDir = path.join(rootPath, 'tasks', 'phase-1');
  if (fs.existsSync(phaseDir)) fs.chmodSync(phaseDir, 0o555);

  // Now claim the task — in-transaction writes should succeed; syncFiles fails silently
  const claimRes = claimTask({ taskId, actor: actor(agentId) });

  // Restore perms
  if (fs.existsSync(phaseDir)) fs.chmodSync(phaseDir, 0o755);

  // The transition should succeed regardless
  expect(claimRes.status).toBe(200);

  // audit_log gets 2 rows: one for create + one for claim
  const audits = readAuditLog(projectId);
  expect(audits.length).toBeGreaterThanOrEqual(2);
  expect(audits.some((a) => a.event_type === 'task_claimed')).toBe(true);

  // ledger.jsonl gets at least 2 lines
  const lines = readLedger(rootPath);
  expect(lines.length).toBeGreaterThanOrEqual(2);
  expect(lines.some((l) => l.event_type === 'task_claimed')).toBe(true);

  // task row updated
  expect(getTaskRow(taskId).status).toBe('claimed');
});
