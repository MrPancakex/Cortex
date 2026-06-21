-- Migration 011 — codex_review_threads.
--
-- Persistent thread continuity for the codex-reviewer plugin
-- (Codex-app-server multi-turn review loop). Maps a single (task_id,
-- reviewer_agent) pair to the Codex conversation_id so a gateway
-- restart mid-review keeps the same Codex thread alive — codex does
-- not re-pay full context-load on the next turn.
--
-- §12.8 (home-check 2026-04-24) decided run-level + event-level state
-- stays IN-MEMORY by design. This migration deliberately does NOT
-- create codex_review_runs or codex_review_events. The bridge tables
-- (review_request → reply) are the correctness anchor; thread reuse
-- is the one Phase-11 regression worth rescuing.
--
-- Backfill from the legacy `~/Cortex/data/gateway.db` is operator-run
-- via scripts/migrate-codex-threads.js. The migration only creates
-- schema.

CREATE TABLE IF NOT EXISTS codex_review_threads (
  task_id          TEXT    NOT NULL CHECK (length(task_id) > 0),
  reviewer_agent   TEXT    NOT NULL CHECK (length(reviewer_agent) > 0),
  thread_id        TEXT    NOT NULL CHECK (length(thread_id) > 0),
  last_turn_id     TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (task_id, reviewer_agent)
);

-- Hot path is read-by-(task,reviewer) which the PK already covers.
-- Index updated_at for the orphan reaper / observability queries
-- ("which threads were active most recently").
CREATE INDEX IF NOT EXISTS idx_codex_review_threads_updated
  ON codex_review_threads(updated_at);
