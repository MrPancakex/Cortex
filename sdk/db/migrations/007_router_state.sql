-- Phase 8 — declarative routing rules for the router plane.
--
-- Applied inside runner.withTransaction(); MUST NOT contain its own
-- BEGIN/COMMIT (see runner.js).
--
-- The router owns three decision kinds: task assignment, bridge fan-out,
-- reviewer selection (plus a 'proxy' plane for the path-based provider
-- routing lifted from lib/proxy.js). Each row is a RoutingRule (see
-- core/schemas/routing.js); the JSON columns carry the scope / match /
-- target blocks.
--
-- The table is intentionally flat. A single PRIMARY KEY on id + a
-- partial index on (priority, id) WHERE enabled=1 covers every hot-path
-- access. Rules are plane-scoped via scope_json.plane — there is no
-- separate per-plane table because the three planes share ~90% of
-- their matcher vocabulary.

CREATE TABLE IF NOT EXISTS routing_rules (
  id           TEXT PRIMARY KEY,
  description  TEXT,
  scope_json   TEXT NOT NULL,
  match_json   TEXT NOT NULL,
  target_json  TEXT NOT NULL,
  priority     INTEGER NOT NULL DEFAULT 1000,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Hot-path query is "enabled rows, ordered by priority ASC, id ASC"
-- across every plane. rules.js filters by plane in JS (cheap given the
-- typical rule count is <100), so the index does not include plane.
CREATE INDEX IF NOT EXISTS idx_routing_rules_priority
  ON routing_rules (priority, id)
  WHERE enabled = 1;

-- Seed each plane with a single catch-all rule. These are intentionally
-- permissive — a rejection is expressed by a higher-priority rule with
-- target.effect='skip'. The target shape matches RoutingTargetSchema
-- (kind + value + effect) so parseRoutingRule accepts each row on load.
INSERT OR IGNORE INTO routing_rules
  (id, description, scope_json, match_json, target_json, priority, enabled,
   created_at, updated_at)
VALUES
  ('default.task',
   'default task-assignment rule — match any eligible task',
   json('{"plane":"task"}'), json('{}'),
   json('{"kind":"internal","value":"task.next","effect":"route","preserve_agent_prefix":true}'),
   9000, 1, (unixepoch() * 1000), (unixepoch() * 1000)),
  ('default.bridge',
   'default bridge routing — pass recipients through untouched',
   json('{"plane":"bridge"}'), json('{}'),
   json('{"kind":"internal","value":"bridge.recipient","effect":"route","preserve_agent_prefix":true}'),
   9000, 1, (unixepoch() * 1000), (unixepoch() * 1000)),
  ('default.reviewer',
   'default reviewer picker — match any eligible reviewer',
   json('{"plane":"reviewer"}'), json('{}'),
   json('{"kind":"internal","value":"review.assign","effect":"route","preserve_agent_prefix":true}'),
   9000, 1, (unixepoch() * 1000), (unixepoch() * 1000));
