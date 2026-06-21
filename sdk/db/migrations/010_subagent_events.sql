-- Migration 010 — subagent_events.
--
-- Activity + cost ledger for subagents (task-workers, general-purpose,
-- codex-watcher, etc.). Distinct from `subagents` (migration 005) which
-- is the process table (PID, exit_code) for spawned children.
--
-- Each row records:
--   * Identity:      parent_agent, subagent_id, subagent_type, description
--   * Lifecycle:     status, started_at, completed_at, duration_ms
--   * Work product:  tool_calls, result_summary
--   * Cost:          input_tokens, cached_input_tokens, output_tokens, cost_usd
--   * Attribution:   model, provider, runtime
--
-- Two write paths populate the table:
--   1. Auto: claim_task → INSERT(status='running'); submit_result → UPDATE
--      via the lifecycle helpers in sdk/sessions/subagent-lifecycle.js.
--      This is the legacy "task-worker" pattern and is what the dashboard
--      reads for "what is each agent working on right now."
--   2. Manual: subagent_register / subagent_complete MCP tools — for
--      non-task subagents (general-purpose worker, codex-watcher, etc.)
--      where the parent agent self-reports tokens + cost on completion.
--
-- Schema mirrors the legacy services/gateway/lib/db.js subagent_events
-- table so a side-by-side comparison during cutover is one-to-one.

CREATE TABLE IF NOT EXISTS subagent_events (
  id                    TEXT PRIMARY KEY,
  parent_agent          TEXT NOT NULL,
  subagent_id           TEXT NOT NULL,
  subagent_type         TEXT,
  description           TEXT,
  task_id               TEXT,
  -- Defense-in-depth: the application layer enforces SUBAGENT_TERMINAL_STATUSES
  -- via assertTerminalStatus, but a direct DB write or a future MCP write path
  -- could insert an out-of-enum value the orphan reaper's status='running'
  -- filter would never clear. Constraining at the DB level closes that gap.
  status                TEXT NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running','completed','failed','cancelled')),
  started_at            INTEGER NOT NULL,
  completed_at          INTEGER,
  duration_ms           INTEGER NOT NULL DEFAULT 0,
  tool_calls            INTEGER NOT NULL DEFAULT 0,
  result_summary        TEXT,
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cost_usd              REAL    NOT NULL DEFAULT 0,
  model                 TEXT,
  provider              TEXT,
  runtime               TEXT
);

-- Dashboard query: "what is parent X working on, ordered by recency."
CREATE INDEX IF NOT EXISTS idx_subagent_events_parent_started
  ON subagent_events(parent_agent, started_at DESC);

-- Task → subagent lookup (used by lookupRunningTaskWorker on submit_result
-- when the caller doesn't echo the event_id back).
CREATE INDEX IF NOT EXISTS idx_subagent_events_task
  ON subagent_events(task_id);

-- Orphan reaper: find old still-running rows. status='running' is the
-- common filter; started_at gives the reaper a way to bound the scan.
CREATE INDEX IF NOT EXISTS idx_subagent_events_status_started
  ON subagent_events(status, started_at);
