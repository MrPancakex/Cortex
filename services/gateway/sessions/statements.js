/**
 * Prepared-statement map for the sessions plane — covers the `sessions`
 * and `agents` tables plus the `tasks` join used by the orphan dispatcher.
 * Lazy-constructed on first access so a test can `resetDbForTests()`
 * between suites without the module holding a stale handle.
 *
 * Column set matches sdk/db/migrations/001_initial_schema.sql after the
 * Phase 6 `004_sessions_registry.sql` additions (base_agent, slot, pid,
 * opened_at, last_heartbeat_at, closed_at, held_task_ids,
 * session_metadata on sessions; plus supervisor columns on agents).
 */

import { getDb, createStatements } from '@cortex/sdk/db';

const SPECS = [
  // ---- sessions CRUD ----
  {
    name: 'insertSession',
    sql: `INSERT INTO sessions
      (id, agent_id, task_id, status, base_agent, slot, pid,
       opened_at, last_heartbeat_at, held_task_ids, session_metadata)
      VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  },
  {
    name: 'getSession',
    sql: 'SELECT * FROM sessions WHERE id = ?',
  },
  {
    name: 'listActiveSessions',
    sql: `SELECT * FROM sessions
      WHERE status = 'active' OR status = 'open'
      ORDER BY opened_at ASC`,
  },
  {
    name: 'listSessionsForBase',
    sql: `SELECT * FROM sessions
      WHERE base_agent = ?
      ORDER BY slot ASC`,
  },
  {
    name: 'listStaleSessions',
    // last_heartbeat_at < cutoff AND not already closed/expired
    sql: `SELECT * FROM sessions
      WHERE (status = 'active' OR status = 'open')
      AND (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < ?)`,
  },
  {
    name: 'updateSessionHeartbeat',
    // Only active/open rows — a closed or expired session must NOT be
    // resurrected by a late heartbeat from a dying agent. Zero-row
    // return there is correct (the caller handles it as a no-op).
    sql: `UPDATE sessions
      SET last_heartbeat_at = ?
      WHERE id = ?
      AND (status = 'active' OR status = 'open')`,
  },
  {
    name: 'updateSessionHeldTasks',
    sql: `UPDATE sessions
      SET held_task_ids = ?
      WHERE id = ?`,
  },
  {
    name: 'closeSession',
    sql: `UPDATE sessions
      SET status = ?, closed_at = ?
      WHERE id = ?`,
  },
  {
    name: 'deleteSession',
    sql: 'DELETE FROM sessions WHERE id = ?',
  },

  // ---- agents CRUD + heartbeat persistence ----
  {
    name: 'insertAgent',
    sql: `INSERT INTO agents
      (id, name, kind, status, capabilities, model, provider, metadata, platform)
      VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  },
  {
    name: 'getAgent',
    sql: 'SELECT * FROM agents WHERE id = ?',
  },
  {
    name: 'listAgents',
    sql: 'SELECT * FROM agents ORDER BY registered_at DESC',
  },
  {
    name: 'upsertAgentHeartbeat',
    // Only bumps the heartbeat columns; leaves registration metadata
    // untouched. Agent row must already exist (upstream caller handles
    // registration).
    sql: `UPDATE agents
      SET last_heartbeat_at = ?, current_task = ?, platform = COALESCE(?, platform), status = 'online'
      WHERE id = ?`,
  },
  {
    name: 'getStaleAgents',
    // last_heartbeat_at < cutoff AND still marked online — surfaces the
    // agents that should emit agent.stale.
    sql: `SELECT id, last_heartbeat_at FROM agents
      WHERE status = 'online'
      AND (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < ?)`,
  },
  {
    name: 'markAgentStale',
    sql: `UPDATE agents
      SET status = 'stale'
      WHERE id = ?`,
  },
  {
    name: 'upsertAgentProcessState',
    // Supervisor persistence target — mirrors the legacy `heartbeats`
    // upsertProcessState statement (services/gateway/lib/db.js:567).
    sql: `UPDATE agents
      SET process_state = ?, pid = ?, unstable_restarts = ?, first_failure_at = ?, last_heartbeat_at = ?
      WHERE id = ?`,
  },
  {
    name: 'getAgentProcessState',
    sql: `SELECT id as agent_id, process_state, pid, started_at,
      unstable_restarts, first_failure_at, next_restart_at, restart_delay_ms
      FROM agents WHERE id = ?`,
  },
  {
    name: 'getAgentHeartbeat',
    sql: 'SELECT id AS agent_id, last_heartbeat_at, current_task, platform, status FROM agents WHERE id = ?',
  },
  {
    name: 'getSessionHeartbeats',
    // The legacy `getSessionHeartbeats` query: match exact id OR any
    // `<base>-N` under the same base.
    sql: `SELECT id AS agent_id, last_heartbeat_at, current_task, platform, status
      FROM agents
      WHERE id = ?1 OR id LIKE ?1 || '-%'
      ORDER BY last_heartbeat_at DESC`,
  },

  // ---- task-side orphan lookup ----
  {
    name: 'getHeldTasksBySession',
    // The sessions plane never mutates tasks — it only reads what's held
    // so the orphan-dispatcher can emit task.orphaned events. The tasks
    // plane (Phase 5) is the sole writer of task status transitions.
    sql: `SELECT id, assigned_to, status
      FROM tasks
      WHERE assigned_to = ?
      AND status IN ('claimed', 'in_progress')`,
  },
];

let _cached = null;
let _cachedDb = null;

export function getSessionStatements() {
  const db = getDb();
  // Auto-invalidate when the underlying db singleton changed (tests
  // rotate DB paths via resetDbForTests + fresh getDb({path})). A
  // forgotten resetSessionStatementsForTests() in a test beforeEach
  // would otherwise reuse prepared statements bound to a stale file.
  if (_cached && _cachedDb === db) return _cached;
  _cached = createStatements(db, SPECS);
  _cachedDb = db;
  return _cached;
}

export function resetSessionStatementsForTests() {
  _cached = null;
  _cachedDb = null;
}
