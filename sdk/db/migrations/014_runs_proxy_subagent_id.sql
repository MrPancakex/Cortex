-- Migration 014 — runs.proxy_subagent_id.
--
-- Slice C Phase 1 (2026-05-25): add the join column from `runs` (slice B
-- Plane-2 bounded runtime ledger, migration 013) to `subagents` (Plane-2
-- process registry, migration 005). Slice B Phase 5 (the /close route)
-- could mark a run cancelled in DB but had no path to SIGTERM the actual
-- process because runs.run_id had no link to subagents.id. This column
-- closes that gap.
--
-- Slice C Phases 4-5 sibling work populates the column from
-- services/gateway/subagents/spawn.js after the proxy spawn returns
-- {id, pid, ...}. Pre-existing rows have NULL — they're historical and
-- their underlying processes are already dead.
--
-- FK target is subagents.id (the proxy process table), NOT
-- subagent_events.subagent_id (the telemetry text identifier). Researcher
-- confirmed 2026-05-25 that subagent-spawn.js writes the subagents row
-- (lines 100-111) and returns its id as the natural join key.
--
-- No down migration. ALTER TABLE ADD COLUMN is irreversible in SQLite
-- (per slice A Phase 4 convention). Pre-existing rows will have
-- proxy_subagent_id = NULL which is the correct semantic for historical
-- runs whose underlying processes are no longer alive.

ALTER TABLE runs ADD COLUMN proxy_subagent_id TEXT REFERENCES subagents(id);
CREATE INDEX IF NOT EXISTS idx_runs_proxy_subagent
  ON runs (proxy_subagent_id);
