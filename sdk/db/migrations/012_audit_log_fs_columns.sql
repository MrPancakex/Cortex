-- Migration 012 — audit_log table + tasks fs-tracking columns.
--
-- Slice A Phase 4 of the Cortex re-vamp (Ledger Foundation).
-- Reference: services/gateway/tasks/LEDGER-SCHEMA.md §5 and §7.10.
--
-- Three schema changes:
--
--   1. CREATE audit_log — the persistent event log for the C3 dual-write
--      contract (§3). Every state transition writes one row inside the
--      same SQLite transaction that mutates the tasks row and appends
--      a line to the on-disk ledger.jsonl. Without this table the
--      stmts.insertAudit call in dualWrite() (§3.1) has no target.
--
--   2. ALTER TABLE tasks ADD COLUMN folder_path TEXT — nullable cache of
--      the absolute on-disk path for this task's directory. Populated by
--      syncTaskFileLifecycle after the first writeTaskJson call. Null until
--      then; callers must fall back to findTaskFolderByUuid when null.
--      See LEDGER-SCHEMA.md §5.3.
--
--   3. ALTER TABLE tasks ADD COLUMN fs_version INTEGER NOT NULL DEFAULT 0 —
--      monotonic counter bumped on every successful writeTaskJson call.
--      The reconciler compares tasks.fs_version to task.json.fs_version
--      to decide whether the DB or the file is more recent (§5.2).
--
-- NOTE on down migration: SQLite's ALTER DROP COLUMN support was added
-- in SQLite 3.35.0 (2021-03-12) but bun:sqlite may be linked against
-- an older version. Dropping columns via ALTER TABLE is therefore not
-- safe as a generic rollback strategy. The two column additions
-- (folder_path and fs_version) are irreversible in this migration
-- mechanism — any rollback would need to recreate the tasks table
-- without those columns. Given that folder_path and fs_version hold
-- no user-supplied data and carry safe defaults (NULL / 0), the
-- practical rollback is to redeploy the prior codebase without running
-- this migration (which cannot run twice due to the schema_migrations
-- guard). The audit_log table can be dropped if needed.

-- -------------------------------------------------------------------------
-- 1. audit_log table
-- -------------------------------------------------------------------------
--
-- Columns match the dual-write pseudocode in §3.1 exactly:
--   id          — UUID v4, TEXT PRIMARY KEY
--   task_id     — back-reference to the task that transitioned
--   project_id  — redundant but makes rows self-contained for the
--                 reconciler parity invariant (§2.7)
--   actor       — agent_id string or the literal "system"
--   event_type  — see §6 for the full enum across all 23 operations
--   payload     — JSON object; event-specific data. DEFAULT '{}' so the
--                 column is always valid JSON even when the caller omits it.
--   created_at  — TEXT NOT NULL DEFAULT (datetime('now')) — SQLite wall-clock
--                 at insert time, matching the convention used by tasks and
--                 progress_reports in migration 001.
--
-- FK conventions follow migration 001 (ON DELETE CASCADE for task_id and
-- project_id so hard-deleting a task or project automatically prunes its
-- audit rows, keeping the parity invariant achievable for new data while
-- avoiding orphaned rows).

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT    NOT NULL PRIMARY KEY,
  task_id     TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id  TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor       TEXT    NOT NULL,
  event_type  TEXT    NOT NULL,
  payload     TEXT             DEFAULT '{}',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Index 1: (task_id, created_at) — reconciler and UI "events for this task"
-- ordered chronologically. The most common read pattern.
CREATE INDEX IF NOT EXISTS idx_audit_log_task_created
  ON audit_log (task_id, created_at);

-- Index 2: (project_id, created_at) — reconciler parity check
-- (countAuditForProject) and the ledger-parity scan in §4.2 step 6.
CREATE INDEX IF NOT EXISTS idx_audit_log_project_created
  ON audit_log (project_id, created_at);

-- Index 3: (event_type, created_at) — observability / analytics queries
-- ("all task_claimed events in the last hour"). Not on the hot path for
-- correctness but cheap to maintain and expected by the reconciler §2.7.
CREATE INDEX IF NOT EXISTS idx_audit_log_event_created
  ON audit_log (event_type, created_at);

-- -------------------------------------------------------------------------
-- 2. tasks.folder_path — nullable absolute path cache
-- -------------------------------------------------------------------------
ALTER TABLE tasks ADD COLUMN folder_path TEXT;

-- -------------------------------------------------------------------------
-- 3. tasks.fs_version — monotonic sync counter
-- -------------------------------------------------------------------------
ALTER TABLE tasks ADD COLUMN fs_version INTEGER NOT NULL DEFAULT 0;
