-- Phase 6 — sessions registry + agent heartbeat columns.
--
-- The baseline schema (001_initial_schema.sql) ships with `agents` and
-- `sessions` tables. Phase 6 adds the columns that the sessions plane
-- needs to track lease-slot identity, process-supervisor state, and the
-- orphan-triggering held-task list:
--
--   sessions: base_agent + slot + pid + opened/last_heartbeat/closed + held_task_ids
--   agents:   last_heartbeat_at + process_state + pid + unstable_restarts +
--             first_failure_at + next_restart_at + restart_delay_ms
--
-- These match legacy services/gateway/lib/db.js (lines 301-314) for the
-- `heartbeats` table except we fold them into `agents` directly — the
-- rebuild has no separate heartbeats table. A session row mirrors the
-- canonical sess_<slot> identity created by sdk/sessions/claim.js.

-- sessions additions
ALTER TABLE sessions ADD COLUMN base_agent TEXT;
ALTER TABLE sessions ADD COLUMN slot INTEGER;
ALTER TABLE sessions ADD COLUMN pid INTEGER;
ALTER TABLE sessions ADD COLUMN opened_at INTEGER;
ALTER TABLE sessions ADD COLUMN last_heartbeat_at INTEGER;
ALTER TABLE sessions ADD COLUMN closed_at INTEGER;
-- Stored as JSON array so a single row holds every held task id without
-- a second table — the reaper reads this for orphan dispatch.
ALTER TABLE sessions ADD COLUMN held_task_ids TEXT DEFAULT '[]';
-- Free-form context (runtime kind, host, version). JSON blob — readers
-- must tolerate corrupt JSON via safeJsonParse.
ALTER TABLE sessions ADD COLUMN session_metadata TEXT DEFAULT '{}';

-- One session row per session id. (Unique already via PRIMARY KEY id.)
-- Secondary index speeds the per-base-agent list used by the reaper.
CREATE INDEX IF NOT EXISTS idx_sessions_base ON sessions (base_agent, slot);
CREATE INDEX IF NOT EXISTS idx_sessions_heartbeat ON sessions (last_heartbeat_at);

-- agents additions — process-supervisor persistence target. Mirrors the
-- legacy `heartbeats` table columns (db.js:301-314) so the existing
-- ProcessSupervisor persistStateSafe() path keeps working verbatim once
-- pointed at this DB.
ALTER TABLE agents ADD COLUMN last_heartbeat_at INTEGER;
ALTER TABLE agents ADD COLUMN process_state TEXT DEFAULT 'unknown';
ALTER TABLE agents ADD COLUMN pid INTEGER;
ALTER TABLE agents ADD COLUMN started_at INTEGER;
ALTER TABLE agents ADD COLUMN unstable_restarts INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN first_failure_at INTEGER;
ALTER TABLE agents ADD COLUMN next_restart_at INTEGER;
ALTER TABLE agents ADD COLUMN restart_delay_ms INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN current_task TEXT;
ALTER TABLE agents ADD COLUMN platform TEXT;

-- Stale-agent sweep: reaper SELECTs WHERE last_heartbeat_at < ? — a
-- single-column index suffices.
CREATE INDEX IF NOT EXISTS idx_agents_last_heartbeat ON agents (last_heartbeat_at);
