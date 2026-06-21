-- Phase 3 — durable event substrate.
--
-- Append-only events table. Emitters call sdk/events/emit() which validates
-- the payload against core/schemas/events/ and INSERTs one row here inside
-- a transaction before notifying in-process subscribers. Downstream
-- consumers (dashboards, WS/cursor transports) read via `seq` which gives
-- them a monotonic resume point across disconnects.
--
-- `seq` is the cursor: INTEGER PRIMARY KEY AUTOINCREMENT guarantees SQLite
-- never re-issues an id even if the row at max(seq) is vacuumed, so
-- subscribers can safely store the last seq they processed.
--
-- `id` is an application-generated UUID used for idempotency checks on
-- recovery replay (see sdk/events/recovery.js).

CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  subject    TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  source     TEXT NOT NULL,
  task_id    TEXT,
  session_id TEXT,
  trace_id   TEXT,
  payload    TEXT NOT NULL,
  v          INTEGER NOT NULL DEFAULT 1
);

-- Cursor replay by subject glob: scans are (subject, seq) ordered.
CREATE INDEX IF NOT EXISTS idx_events_subject_seq ON events (subject, seq);

-- Retention (vacuum): delete WHERE ts < cutoff.
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);

-- Per-entity timelines: the dashboard wants `all events for task X, in
-- seq order`. A composite (task_id, seq) index lets SQLite return rows
-- pre-sorted without a separate ORDER BY pass. Same rationale for
-- session_id.
CREATE INDEX IF NOT EXISTS idx_events_task_seq ON events (task_id, seq) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events (session_id, seq) WHERE session_id IS NOT NULL;
