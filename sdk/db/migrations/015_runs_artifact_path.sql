-- Migration 015 — runs.artifact_path + nullable LLM fields.
--
-- Slice F.1 (2026-05-25): production-tool runs (render-tool, Blender,
-- and similar tools) produce artifacts (rendered images, scenes, builds)
-- and have no LLM tokens or cost. The existing runs schema (migration 013)
-- modeled only LLM runs.
--
-- Changes:
--   - artifact_path: TEXT, nullable. Either a single path or a JSON
--     array of paths. Caller's choice; the dashboard knows both shapes.
--   - tokens_in, tokens_out: drop NOT NULL constraint (already
--     DEFAULT 0; nullable is the more honest representation for
--     non-LLM runs that produced no tokens).
--   - cost_usd: drop NOT NULL constraint (same reasoning).
--
-- SQLite doesn't support DROP NOT NULL directly. Standard pattern is
-- recreate the table. Since runs is small (low volume during slice F
-- onboarding) and we have FK references, do a transactional copy.
--
-- NOTE: The migration runner (runner.js) wraps each .sql file in a
-- db.transaction() call, so BEGIN/COMMIT are intentionally absent here.

-- 1. Create replacement table with updated constraints
CREATE TABLE runs_new (
  run_id                  TEXT    NOT NULL PRIMARY KEY,
  task_id                 TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  provider_id             TEXT    NOT NULL,
  model                   TEXT    NOT NULL,
  status                  TEXT    NOT NULL DEFAULT 'running'
                          CHECK (status IN ('running','completed','failed','cancelled','budget_exceeded')),
  started_at              TEXT    NOT NULL DEFAULT (datetime('now')),
  ended_at                TEXT,
  tokens_in               INTEGER,                            -- NULLABLE now (null for non-LLM runs)
  tokens_out              INTEGER,                            -- NULLABLE now (null for non-LLM runs)
  cost_usd                REAL,                               -- NULLABLE now (null for non-LLM runs)
  exit_reason             TEXT,
  budget_max_tokens       INTEGER,
  budget_max_wall_seconds INTEGER,
  budget_max_tool_calls   INTEGER,
  proxy_subagent_id       TEXT REFERENCES subagents(id),
  artifact_path           TEXT                                -- NEW: single path or JSON array of paths
);

-- 2. Copy existing data (artifact_path = NULL for all pre-existing rows)
INSERT INTO runs_new
  SELECT run_id, task_id, provider_id, model, status, started_at, ended_at,
         tokens_in, tokens_out, cost_usd, exit_reason,
         budget_max_tokens, budget_max_wall_seconds, budget_max_tool_calls,
         proxy_subagent_id, NULL
  FROM runs;

-- 3. Swap tables
DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;

-- 4. Restore indexes
CREATE INDEX IF NOT EXISTS idx_runs_task        ON runs (task_id, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_provider    ON runs (provider_id, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_status      ON runs (status, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_proxy_subagent ON runs (proxy_subagent_id);
CREATE INDEX IF NOT EXISTS idx_runs_artifact    ON runs (artifact_path) WHERE artifact_path IS NOT NULL;
