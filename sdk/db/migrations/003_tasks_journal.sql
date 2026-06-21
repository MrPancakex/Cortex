-- Phase 5 — structured task journal + orphaned status.
--
-- This migration is applied inside the runner's withTransaction(), so it
-- MUST NOT include its own BEGIN/COMMIT — doing so fails with "cannot
-- start a transaction within a transaction".
--
-- Purpose:
--   1. Add the `task_journal` table. The journal is the authoritative
--      completeness signal for submit_result and request_verification.
--      Replaces the legacy pattern-matching over progress_reports.status
--      (which could be gamed with any two rows tagged 'planning' +
--      'testing'). The new contract requires structured rows whose
--      `entry_type` is a closed enum (CHECK constraint below) and whose
--      `summary` is non-empty.
--
--   2. Record `orphaned` as a valid task status.
--      The base schema (001_initial_schema.sql) intentionally left
--      tasks.status without a CHECK constraint so Phase 5 could add the
--      'orphaned' terminal-waiting state without a full table rebuild.
--      The TaskStatusSchema in core/schemas/task.js is the authoritative
--      enum; the DB permits any string, and all writes come through the
--      gateway which validates first.

CREATE TABLE IF NOT EXISTS task_journal (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  entry_type    TEXT NOT NULL CHECK(entry_type IN (
    'planning','context','decision','test','blocker','handoff'
  )),
  summary       TEXT NOT NULL,
  files_changed TEXT NOT NULL DEFAULT '[]',
  metadata      TEXT NOT NULL DEFAULT '{}',
  author        TEXT NOT NULL,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

-- (task_id, created_at) drives the chronological read path consumed by
-- readJournal() and the Phase 5 handoff text in orphan.claimOrphan.
CREATE INDEX IF NOT EXISTS idx_task_journal_task_time
  ON task_journal(task_id, created_at);

-- (task_id, entry_type) drives checkJournalCompleteness() — the per-task
-- "do we have a planning/context/test row" probe used by submitTask.
CREATE INDEX IF NOT EXISTS idx_task_journal_task_type
  ON task_journal(task_id, entry_type);

-- Author lookup for the dashboard's "journal activity by agent" panel.
CREATE INDEX IF NOT EXISTS idx_task_journal_author_time
  ON task_journal(author, created_at);
