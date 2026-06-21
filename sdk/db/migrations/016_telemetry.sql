-- Migration 016 — telemetry ingest table (Foundation F2).
--
-- The v1 rebuild never ported the legacy `POST /api/gateway/telemetry`
-- ingest plane (docs/cortex-rebuild-home-check-2026-04-24.md §12.4 / line
-- 307). dispatch.js logTelemetry was a no-op and the telemetry_report MCP
-- tool was a not_implemented stub for want of a backing table + route.
--
-- This table records ONE row per self-reported call. Distinct semantic from
-- proxy_logs (migration 005): proxy_logs captures calls that flow THROUGH the
-- gateway proxy; `telemetry` captures usage self-reported by an agent/tool
-- for calls that do NOT traverse the proxy (e.g. an MCP tool dispatch, or a
-- direct provider call an agent wants on the cost ledger). Cost aggregation
-- can UNION the two sources so neither plane is lost.
--
-- Schema mirrors the telemetry_report MCP tool's frozen input contract
-- (services/gateway/mcp/tools/telemetry_report.js):
--   {method, endpoint, model, provider, tokens_in, tokens_out, cost_usd,
--    latency_ms}
-- plus the persistence columns the ingest route stamps (agent_id, project_id,
-- created_at). agent + project are nullable: a dispatch with no resolved
-- identity still records latency.
--
-- created_at is integer Unix milliseconds — matches proxy_logs.created_at so
-- a UNION over the two tables compares timestamps directly without a
-- datetime() conversion.
--
-- IF NOT EXISTS keeps the migration idempotent: re-running it (e.g. after a
-- gateway restart, where runMigrations() also skips it via schema_migrations)
-- is a no-op rather than an error.

CREATE TABLE IF NOT EXISTS telemetry (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id    TEXT,
  project_id  TEXT,
  method      TEXT,
  endpoint    TEXT,
  model       TEXT,
  provider    TEXT,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  cost_usd    REAL    NOT NULL DEFAULT 0,
  latency_ms  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telemetry_agent_created   ON telemetry (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_project_created ON telemetry (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_model_created   ON telemetry (model, created_at DESC);
