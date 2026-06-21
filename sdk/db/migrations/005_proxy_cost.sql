-- Phase 9 — proxy plane tables.
--
-- Three additions layered on top of the Phase-1 cost_entries table:
--   1. proxy_logs — per-request log row (one per upstream LLM call).
--      Split from cost_entries because logs are write-once / mostly-forget
--      and do not need the composite indexes cost aggregation demands.
--   2. cost_budgets — per-project sliding-window spend caps. Consulted
--      on every upstream fetch by proxy/cost.js:checkBudget.
--   3. subagents — process-table row for spawned child agents. The
--      proxy's subagent-spawn / subagent-control modules own this.
--
-- Nothing in here touches cost_entries — that table already carries the
-- cache_read_tokens / cache_write_tokens columns Phase 9 needs.

CREATE TABLE IF NOT EXISTS proxy_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT,
  provider TEXT NOT NULL,
  route TEXT,
  method TEXT,
  path TEXT,
  status INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  agent_id TEXT,
  project_id TEXT,
  streaming INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_proxy_logs_agent_created ON proxy_logs(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_proxy_logs_project_created ON proxy_logs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_proxy_logs_model_created ON proxy_logs(model, created_at DESC);

-- cost_entries composite indexes for aggregation queries (`WHERE
-- project_id = ? AND created_at >= ?`). The Phase-1 schema only ships
-- `idx_cost_task`; add project/agent variants here since the proxy's
-- aggregation queries live in this phase.
CREATE INDEX IF NOT EXISTS idx_cost_entries_agent_created ON cost_entries(agent_id, created_at);

CREATE TABLE IF NOT EXISTS cost_budgets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  limit_usd REAL NOT NULL CHECK (limit_usd >= 0),
  window_seconds INTEGER NOT NULL CHECK (window_seconds > 0),
  window_started_at INTEGER NOT NULL,
  warn_thresholds_pct TEXT NOT NULL DEFAULT '[50,80,95]',
  enforcement TEXT NOT NULL DEFAULT 'warn' CHECK (enforcement IN ('warn', 'throttle', 'halt')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cost_budgets_project_active ON cost_budgets(project_id, active);

CREATE TABLE IF NOT EXISTS subagents (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  profile TEXT NOT NULL,
  workspace TEXT,
  pid INTEGER,
  state TEXT NOT NULL DEFAULT 'spawning',
  exit_code INTEGER,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_subagents_parent ON subagents(parent_id);
CREATE INDEX IF NOT EXISTS idx_subagents_state ON subagents(state);
