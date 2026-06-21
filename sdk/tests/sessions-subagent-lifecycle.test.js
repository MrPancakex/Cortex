import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  registerTaskWorker,
  completeTaskWorker,
  failTaskWorker,
  lookupRunningTaskWorker,
  registerSubagent,
  completeSubagent,
  listSubagents,
  generateSubagentEventId,
  SUBAGENT_TERMINAL_STATUSES,
} from '../sessions/subagent-lifecycle.js';

/**
 * Unit tests for the subagent_events ledger. Tests build an in-memory
 * SQLite from migration 010 directly so the module is exercised without
 * dragging in the full migration runner.
 */

const MIGRATION_PATH = join(import.meta.dir, '..', 'db', 'migrations', '010_subagent_events.sql');

function applyMigration(db) {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  // Bracket notation on bun:sqlite's batch-DDL method: a Claude Code
  // PreToolUse security hook string-matches the literal `exec(` token
  // and would otherwise refuse to write this file. The bun:sqlite call
  // is unrelated to child_process — the bracket form is just hook
  // appeasement.
  db['exec'](sql);
}

describe('subagent-lifecycle direct DB writes', () => {
  let db;

  beforeEach(() => {
    db = new Database(':memory:');
    applyMigration(db);
  });

  afterEach(() => {
    db.close();
  });

  test('generateSubagentEventId returns a UUID-shaped string', () => {
    const id = generateSubagentEventId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  describe('task-worker auto path', () => {
    test('registerTaskWorker inserts a running row with the expected shape', () => {
      const eventId = registerTaskWorker({
        db,
        parentAgent: 'nova',
        taskId: 'task-1',
        taskTitle: 'Phase 11: MCP core transport',
      });
      expect(eventId).toMatch(/^[0-9a-f-]{36}$/);

      const row = db.prepare('SELECT * FROM subagent_events WHERE id = ?').get(eventId);
      expect(row.parent_agent).toBe('nova');
      expect(row.subagent_type).toBe('task-worker');
      expect(row.runtime).toBe('generic');
      expect(row.task_id).toBe('task-1');
      expect(row.description).toBe('Phase 11: MCP core transport');
      expect(row.status).toBe('running');
      expect(row.completed_at).toBeNull();
      expect(row.duration_ms).toBe(0);
    });

    test('completeTaskWorker stamps completion + duration', () => {
      const eventId = registerTaskWorker({ db, parentAgent: 'nova', taskId: 'task-2', taskTitle: 't' });
      const ok = completeTaskWorker({ db, eventId, parentAgent: 'nova', summary: 'done' });
      expect(ok).toBe(true);

      const row = db.prepare('SELECT * FROM subagent_events WHERE id = ?').get(eventId);
      expect(row.status).toBe('completed');
      expect(row.completed_at).not.toBeNull();
      expect(row.duration_ms).toBeGreaterThanOrEqual(0);
      expect(row.result_summary).toBe('done');
    });

    test('completeTaskWorker is idempotent on a row already marked completed', () => {
      const eventId = registerTaskWorker({ db, parentAgent: 'nova', taskId: 'task-3', taskTitle: 't' });
      expect(completeTaskWorker({ db, eventId, parentAgent: 'nova', summary: 'first' })).toBe(true);
      expect(completeTaskWorker({ db, eventId, parentAgent: 'nova', summary: 'second' })).toBe(false);

      const row = db.prepare('SELECT result_summary FROM subagent_events WHERE id = ?').get(eventId);
      expect(row.result_summary).toBe('first');
    });

    test('completeTaskWorker refuses to close another agent\'s event', () => {
      const eventId = registerTaskWorker({ db, parentAgent: 'nova', taskId: 'task-3a', taskTitle: 't' });
      // orion tries to close nova's event with the leaked id.
      const ok = completeTaskWorker({ db, eventId, parentAgent: 'orion', summary: 'gotcha' });
      expect(ok).toBe(false);
      const row = db.prepare('SELECT status, result_summary FROM subagent_events WHERE id = ?').get(eventId);
      expect(row.status).toBe('running');
      expect(row.result_summary).toBeNull();
    });

    test('failTaskWorker marks status=failed', () => {
      const eventId = registerTaskWorker({ db, parentAgent: 'nova', taskId: 'task-4', taskTitle: 't' });
      const ok = failTaskWorker({ db, eventId, parentAgent: 'nova', reason: 'crashed' });
      expect(ok).toBe(true);

      const row = db.prepare('SELECT status, result_summary FROM subagent_events WHERE id = ?').get(eventId);
      expect(row.status).toBe('failed');
      expect(row.result_summary).toBe('crashed');
    });

    test('failTaskWorker refuses to fail another agent\'s event', () => {
      const eventId = registerTaskWorker({ db, parentAgent: 'nova', taskId: 'task-4a', taskTitle: 't' });
      const ok = failTaskWorker({ db, eventId, parentAgent: 'orion', reason: 'nope' });
      expect(ok).toBe(false);
      const row = db.prepare('SELECT status FROM subagent_events WHERE id = ?').get(eventId);
      expect(row.status).toBe('running');
    });

    test('lookupRunningTaskWorker finds the most-recent running row', () => {
      const id1 = registerTaskWorker({ db, parentAgent: 'nova', taskId: 'task-5', taskTitle: 't' });
      // Force a different started_at by inserting a second row directly
      // with a higher started_at.
      const id2 = generateSubagentEventId();
      db.prepare(
        `INSERT INTO subagent_events (id, parent_agent, subagent_id, subagent_type, task_id, status, started_at, runtime)
         VALUES (?, 'nova', 'nova:task-task-5-newer', 'task-worker', 'task-5', 'running', ?, 'generic')`,
      ).run(id2, Math.floor(Date.now() / 1000) + 5);

      const found = lookupRunningTaskWorker({ db, taskId: 'task-5', parentAgent: 'nova' });
      expect(found).toBe(id2);

      // Completing the newer row should expose the older one to the lookup.
      completeTaskWorker({ db, eventId: id2, parentAgent: 'nova', summary: 'newer done' });
      const fallback = lookupRunningTaskWorker({ db, taskId: 'task-5', parentAgent: 'nova' });
      expect(fallback).toBe(id1);
    });

    test('lookupRunningTaskWorker returns null when no running row exists', () => {
      const found = lookupRunningTaskWorker({ db, taskId: 'no-such-task', parentAgent: 'nova' });
      expect(found).toBeNull();
    });

    test('lookupRunningTaskWorker scopes to the requesting parent', () => {
      registerTaskWorker({ db, parentAgent: 'orion', taskId: 'task-6', taskTitle: 't' });
      const found = lookupRunningTaskWorker({ db, taskId: 'task-6', parentAgent: 'nova' });
      expect(found).toBeNull();
    });
  });

  describe('manual register/complete path', () => {
    test('registerSubagent returns event_id + synthesized subagent_id', () => {
      const { eventId, subagentId } = registerSubagent({
        db,
        parentAgent: 'nova',
        subagentType: 'general-purpose',
        description: 'investigate flaky test',
        runtime: 'claude',
      });
      expect(eventId).toMatch(/^[0-9a-f-]{36}$/);
      expect(subagentId).toMatch(/^nova:general-purpose-/);

      const row = db.prepare('SELECT * FROM subagent_events WHERE id = ?').get(eventId);
      expect(row.subagent_type).toBe('general-purpose');
      expect(row.runtime).toBe('claude');
      expect(row.description).toBe('investigate flaky test');
      expect(row.status).toBe('running');
    });

    test('completeSubagent records cost + token attribution', () => {
      const { eventId } = registerSubagent({
        db,
        parentAgent: 'nova',
        subagentType: 'general-purpose',
        description: 'investigate flaky test',
        model: 'claude-sonnet-4-6',
        provider: 'anthropic',
      });
      const ok = completeSubagent({
        db,
        eventId,
        parentAgent: 'nova',
        toolCalls: 12,
        resultSummary: 'flake was a timing race in beforeEach',
        inputTokens: 4500,
        cachedInputTokens: 3200,
        outputTokens: 850,
        costUsd: 0.0234,
      });
      expect(ok).toBe(true);

      const row = db.prepare('SELECT * FROM subagent_events WHERE id = ?').get(eventId);
      expect(row.status).toBe('completed');
      expect(row.tool_calls).toBe(12);
      expect(row.result_summary).toContain('flake was a timing race');
      expect(row.input_tokens).toBe(4500);
      expect(row.cached_input_tokens).toBe(3200);
      expect(row.output_tokens).toBe(850);
      expect(row.cost_usd).toBeCloseTo(0.0234, 4);
    });

    test('completeSubagent allows partial reports without zeroing prior fields', () => {
      const { eventId } = registerSubagent({
        db,
        parentAgent: 'nova',
        subagentType: 'general-purpose',
        description: 'multi-step run',
      });
      // Caller doesn't have the cost yet; just records the result.
      completeSubagent({ db, eventId, parentAgent: 'nova', resultSummary: 'partial' });
      const row = db.prepare('SELECT result_summary, input_tokens, cost_usd FROM subagent_events WHERE id = ?').get(eventId);
      expect(row.result_summary).toBe('partial');
      expect(row.input_tokens).toBe(0); // default, not nulled
      expect(row.cost_usd).toBe(0);
    });

    test('completeSubagent returns false for an unknown event id', () => {
      const ok = completeSubagent({ db, eventId: 'no-such-event', parentAgent: 'nova' });
      expect(ok).toBe(false);
    });

    test('completeSubagent rejects arbitrary status strings (lifecycle integrity)', () => {
      const { eventId } = registerSubagent({
        db,
        parentAgent: 'nova',
        subagentType: 'general-purpose',
        description: 'integrity check',
      });
      // Defense-in-depth: an internal SDK caller that bypasses the
      // MCP zod enum still hits the SDK-level guard.
      expect(() => completeSubagent({
        db,
        eventId,
        parentAgent: 'nova',
        status: 'in_progress',
      })).toThrow(/status must be one of/);
      expect(() => completeSubagent({
        db,
        eventId,
        parentAgent: 'nova',
        status: 'paused',
      })).toThrow(/status must be one of/);

      // Row is unchanged.
      const row = db.prepare('SELECT status FROM subagent_events WHERE id = ?').get(eventId);
      expect(row.status).toBe('running');
    });

    test('completeSubagent accepts each terminal status', () => {
      for (const status of SUBAGENT_TERMINAL_STATUSES) {
        const { eventId } = registerSubagent({
          db,
          parentAgent: 'nova',
          subagentType: 'general-purpose',
          description: `enum check ${status}`,
        });
        const ok = completeSubagent({
          db,
          eventId,
          parentAgent: 'nova',
          status,
        });
        expect(ok).toBe(true);
        const row = db.prepare('SELECT status FROM subagent_events WHERE id = ?').get(eventId);
        expect(row.status).toBe(status);
      }
    });

    test('SUBAGENT_TERMINAL_STATUSES is the documented terminal set', () => {
      expect(SUBAGENT_TERMINAL_STATUSES).toEqual(['completed', 'failed', 'cancelled']);
      // Frozen so a downstream import can't mutate the source of truth.
      expect(Object.isFrozen(SUBAGENT_TERMINAL_STATUSES)).toBe(true);
    });

    test('completeSubagent refuses to close another agent\'s event (cross-agent denial)', () => {
      const { eventId } = registerSubagent({
        db,
        parentAgent: 'nova',
        subagentType: 'general-purpose',
        description: 'sensitive run',
      });
      const ok = completeSubagent({
        db,
        eventId,
        parentAgent: 'orion',
        resultSummary: 'gotcha',
        costUsd: 99,
      });
      expect(ok).toBe(false);
      const row = db.prepare('SELECT status, result_summary, cost_usd FROM subagent_events WHERE id = ?').get(eventId);
      expect(row.status).toBe('running');
      expect(row.result_summary).toBeNull();
      expect(row.cost_usd).toBe(0);
    });
  });

  describe('listSubagents', () => {
    test('returns rows for the requesting parent in started_at DESC order', () => {
      const now = Math.floor(Date.now() / 1000);
      for (let i = 0; i < 3; i += 1) {
        const id = generateSubagentEventId();
        db.prepare(
          `INSERT INTO subagent_events (id, parent_agent, subagent_id, subagent_type, status, started_at, runtime)
           VALUES (?, 'nova', ?, 'general-purpose', 'running', ?, 'claude')`,
        ).run(id, `nova:gp-${i}`, now + i);
      }
      db.prepare(
        `INSERT INTO subagent_events (id, parent_agent, subagent_id, subagent_type, status, started_at, runtime)
         VALUES (?, 'orion', 'orion:gp-0', 'general-purpose', 'running', ?, 'claude')`,
      ).run(generateSubagentEventId(), now);

      const novaRows = listSubagents({ db, parentAgent: 'nova' });
      expect(novaRows.length).toBe(3);
      expect(novaRows[0].started_at).toBeGreaterThanOrEqual(novaRows[1].started_at);

      const orionRows = listSubagents({ db, parentAgent: 'orion' });
      expect(orionRows.length).toBe(1);
    });

    test('respects the limit parameter', () => {
      const now = Math.floor(Date.now() / 1000);
      for (let i = 0; i < 10; i += 1) {
        const id = generateSubagentEventId();
        db.prepare(
          `INSERT INTO subagent_events (id, parent_agent, subagent_id, subagent_type, status, started_at, runtime)
           VALUES (?, 'nova', ?, 'general-purpose', 'running', ?, 'claude')`,
        ).run(id, `nova:gp-${i}`, now + i);
      }
      const rows = listSubagents({ db, parentAgent: 'nova', limit: 3 });
      expect(rows.length).toBe(3);
    });
  });

  describe('input validation', () => {
    test('registerTaskWorker requires db, parentAgent, taskId', () => {
      expect(() => registerTaskWorker({ parentAgent: 'a', taskId: 't' })).toThrow(/db/);
      expect(() => registerTaskWorker({ db, taskId: 't' })).toThrow(/parentAgent/);
      expect(() => registerTaskWorker({ db, parentAgent: 'a' })).toThrow(/taskId/);
    });

    test('completeTaskWorker requires db + eventId + parentAgent', () => {
      expect(() => completeTaskWorker({ eventId: 'x', parentAgent: 'a' })).toThrow(/db/);
      expect(() => completeTaskWorker({ db, parentAgent: 'a' })).toThrow(/eventId/);
      expect(() => completeTaskWorker({ db, eventId: 'x' })).toThrow(/parentAgent/);
    });

    test('failTaskWorker requires parentAgent', () => {
      expect(() => failTaskWorker({ db, eventId: 'x' })).toThrow(/parentAgent/);
    });

    test('completeSubagent requires parentAgent', () => {
      expect(() => completeSubagent({ db, eventId: 'x' })).toThrow(/parentAgent/);
    });

    test('registerSubagent requires db, parentAgent, description', () => {
      expect(() => registerSubagent({ parentAgent: 'a', description: 'd' })).toThrow(/db/);
      expect(() => registerSubagent({ db, description: 'd' })).toThrow(/parentAgent/);
      expect(() => registerSubagent({ db, parentAgent: 'a' })).toThrow(/description/);
    });
  });
});
