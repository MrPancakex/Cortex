-- Migration 013 — runs table.
--
-- Slice B (bounded sub-agent runtime) introduces the `runs` table as the
-- derived DB index of runs.jsonl (LEDGER-SCHEMA.md §2.5). One row per
-- sub-agent invocation, written when the run starts, updated when it ends.
--
-- Distinct from `subagent_events` (migration 010, Plane 1 telemetry) and
-- `subagents` (migration 005, Plane 2 process management). `runs` is the
-- Slice B *bounded* runtime ledger — every spawn through the new
-- services/gateway/subagents/ plane writes a row here.
--
-- fs is truth (runs.jsonl in task folder); this table is the queryable
-- projection. Slice A's C3 dual-write semantics apply: runs.jsonl line and
-- this row are written in the same logical transaction.

CREATE TABLE runs (
  run_id                  TEXT    NOT NULL PRIMARY KEY,
  task_id                 TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  provider_id             TEXT    NOT NULL,
  model                   TEXT    NOT NULL,
  status                  TEXT    NOT NULL DEFAULT 'running'
                          CHECK (status IN ('running','completed','failed','cancelled','budget_exceeded')),
  started_at              TEXT    NOT NULL DEFAULT (datetime('now')),
  ended_at                TEXT,
  tokens_in               INTEGER NOT NULL DEFAULT 0,
  tokens_out              INTEGER NOT NULL DEFAULT 0,
  cost_usd                REAL    NOT NULL DEFAULT 0,
  exit_reason             TEXT,
  budget_max_tokens       INTEGER,
  budget_max_wall_seconds INTEGER,
  budget_max_tool_calls   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_runs_task        ON runs (task_id, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_provider    ON runs (provider_id, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_status      ON runs (status, started_at);
