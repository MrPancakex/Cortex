/**
 * Regression test for getAudit() — Defect #1 fix (Slice A Phase 6).
 *
 * Verifies that GET /v1/api/tasks/:id/audit queries the `audit_log` table
 * (populated by the dual-write contract) rather than the legacy
 * progress_reports + task_comments + task_journal tables.
 *
 * Uses a fresh tmpdir DB per test run — NEVER touches the live DB.
 *
 * Run with:
 *   cd $CORTEX_HOME && bun test services/gateway/tasks/tests/task-audit.test.js
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
import { getAudit } from '../queries.js';

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

let ROOT;
let db;

beforeEach(() => {
  resetTaskStatementsForTests();
  resetDbForTests();

  const rand = randomUUID().slice(0, 8);
  ROOT = path.join(os.tmpdir(), `cortex-task-audit-${process.pid}-${rand}`);
  fs.mkdirSync(ROOT, { recursive: true });

  process.env.CORTEX_DB_PATH = path.join(ROOT, 'test.db');
  db = getDb({ path: process.env.CORTEX_DB_PATH });
  runMigrations();
});

afterEach(() => {
  resetTaskStatementsForTests();
  resetDbForTests();
  delete process.env.CORTEX_DB_PATH;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function seedProject() {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO projects (id, name, root_path, metadata) VALUES (?, ?, ?, '{}')`,
  ).run(id, `proj-${id.slice(0, 8)}`, ROOT);
  const phaseId = randomUUID();
  const stmts = getTaskStatements();
  stmts.createPhase.run(phaseId, id, 'Phase 1', 0);
  return { id, phaseId };
}

function seedTask(projectId, phaseId) {
  const taskId = randomUUID();
  db.prepare(`
    INSERT INTO tasks
      (id, project_id, phase_id, title, description, status, priority,
       assigned_to, created_by, tags, metadata, created_at, updated_at)
    VALUES (?, ?, ?, 'Audit test task', '', 'pending', 'medium',
            NULL, 'system', '[]', '{}', datetime('now'), datetime('now'))
  `).run(taskId, projectId, phaseId);
  return taskId;
}

function seedAuditRow(taskId, projectId, { eventType, actor, payload = {}, createdAt } = {}) {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO audit_log (id, task_id, project_id, actor, event_type, payload, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    taskId,
    projectId,
    actor ?? 'system',
    eventType ?? 'task_created',
    JSON.stringify(payload),
    createdAt ?? new Date().toISOString().replace('T', ' ').slice(0, 19),
  );
  return id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('getAudit returns 2 events in chronological order', () => {
  const { id: projectId, phaseId } = seedProject();
  const taskId = seedTask(projectId, phaseId);

  // Insert two audit rows with distinct timestamps so ordering is deterministic.
  const id1 = seedAuditRow(taskId, projectId, {
    eventType: 'task_created',
    actor: 'agent-alpha',
    payload: { to_status: 'pending' },
    createdAt: '2026-01-01 10:00:00',
  });
  const id2 = seedAuditRow(taskId, projectId, {
    eventType: 'task_claimed',
    actor: 'agent-beta',
    payload: { from_status: 'pending', to_status: 'in_progress' },
    createdAt: '2026-01-01 10:01:00',
  });

  const result = getAudit({ taskId });

  expect(result.status).toBe(200);
  expect(result.body.task_id).toBe(taskId);
  expect(result.body.total).toBe(2);
  expect(result.body.events).toHaveLength(2);

  const [first, second] = result.body.events;

  // Chronological order
  expect(first.created_at).toBe('2026-01-01 10:00:00');
  expect(second.created_at).toBe('2026-01-01 10:01:00');

  // Row identity
  expect(first.id).toBe(id1);
  expect(second.id).toBe(id2);

  // Actor and event_type passthrough
  expect(first.event_type).toBe('task_created');
  expect(first.actor).toBe('agent-alpha');
  expect(second.event_type).toBe('task_claimed');
  expect(second.actor).toBe('agent-beta');

  // from_status / to_status promoted to top level
  expect(first.to_status).toBe('pending');
  expect(first.from_status).toBeUndefined();
  expect(second.from_status).toBe('pending');
  expect(second.to_status).toBe('in_progress');

  // payload remainder: promoted keys removed, object still present
  expect(first.payload).toEqual({});
  expect(second.payload).toEqual({});
});

test('getAudit returns empty events array when no audit rows exist for task', () => {
  const { id: projectId, phaseId } = seedProject();
  const taskId = seedTask(projectId, phaseId);

  const result = getAudit({ taskId });

  expect(result.status).toBe(200);
  expect(result.body.total).toBe(0);
  expect(result.body.events).toHaveLength(0);
});

test('getAudit returns 404 for unknown task', () => {
  const result = getAudit({ taskId: randomUUID() });
  expect(result.status).toBe(404);
});

test('getAudit only returns rows for the requested task', () => {
  const { id: projectId, phaseId } = seedProject();
  const taskId1 = seedTask(projectId, phaseId);
  const taskId2 = seedTask(projectId, phaseId);

  seedAuditRow(taskId1, projectId, { eventType: 'task_created', actor: 'system' });
  seedAuditRow(taskId2, projectId, { eventType: 'task_created', actor: 'system' });
  seedAuditRow(taskId2, projectId, { eventType: 'task_claimed', actor: 'agent-x' });

  const result1 = getAudit({ taskId: taskId1 });
  const result2 = getAudit({ taskId: taskId2 });

  expect(result1.body.total).toBe(1);
  expect(result2.body.total).toBe(2);
});
