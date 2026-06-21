-- Router plane index gaps flagged by ultrareview lens 4.
--
-- 1) listAgentsByPlatform (services/gateway/router/statements.js:99) does
--    `SELECT ... FROM agents WHERE platform = ? ORDER BY id ASC`, invoked
--    by the reviewer-picker on every candidate evaluation. Existing
--    `agents` indexes are (status), (kind), (last_heartbeat_at) — none on
--    `platform`. Linear-scan cost grows with registered-agent count.
--
-- 2) countReviewerLoad (services/gateway/router/statements.js:114) does
--    `SELECT COUNT(*) FROM tasks WHERE status='review' AND
--     json_extract(metadata,'$.reviewer_agent') = ?`. Existing `tasks`
--    indexes lead on (project_id, status) or (assigned_to, status); none
--    lead on status alone. Review-state rows are sparse relative to the
--    whole table, so a partial index limited to `status='review'` is both
--    small and perfectly aligned with the lookup.
--
-- Both indexes are IF NOT EXISTS so re-running the migration on an
-- already-applied DB is a no-op.

CREATE INDEX IF NOT EXISTS idx_agents_platform
  ON agents (platform);

CREATE INDEX IF NOT EXISTS idx_tasks_review
  ON tasks (status)
  WHERE status = 'review';
