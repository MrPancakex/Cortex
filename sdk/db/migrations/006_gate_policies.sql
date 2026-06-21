-- Phase 7 — declarative gate policies + fine-grained permissions +
-- registry snapshot for the gate plane's auth middleware.
--
-- This migration is applied inside the runner's withTransaction(), so it
-- MUST NOT include its own BEGIN/COMMIT — doing so fails with "cannot
-- start a transaction within a transaction" (see runner.js).
--
-- Three tables land here:
--
--   gate_policies           — policy rows evaluated by gate/evaluator.js.
--                             JSON columns carry the zod-validated matcher
--                             blocks; the evaluator parses them at load time.
--   gate_permissions        — fine-grained (subject, permission, resource)
--                             grants consulted by gate/permissions.js.
--   gate_registry_snapshot  — single-row snapshot of the token registry so
--                             gate/auth-middleware.js doesn't read the
--                             filesystem on every request.
--
-- Storing shaped JSON (rather than ad-hoc columns for every matcher field)
-- means schema evolution is additive — adding a new matcher kind doesn't
-- require an ALTER TABLE on this file.

CREATE TABLE IF NOT EXISTS gate_policies (
  id               TEXT PRIMARY KEY,
  description      TEXT,
  direction        TEXT NOT NULL DEFAULT 'inbound',
  action           TEXT NOT NULL,
  subject_json     TEXT NOT NULL,
  resource_json    TEXT,
  effect           TEXT NOT NULL,
  rate_limit_json  TEXT,
  reason_code      TEXT,
  priority         INTEGER NOT NULL DEFAULT 1000,
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- Hot-path query is "enabled, ordered by priority ASC, id ASC". A partial
-- index on enabled=1 keeps the scan tight (disabled rows never get read).
CREATE INDEX IF NOT EXISTS idx_gate_policies_priority
  ON gate_policies (priority, id)
  WHERE enabled = 1;

-- Quick lookup by action for the admin UI.
CREATE INDEX IF NOT EXISTS idx_gate_policies_action
  ON gate_policies (action);

CREATE TABLE IF NOT EXISTS gate_permissions (
  subject_id     TEXT NOT NULL,
  permission     TEXT NOT NULL,
  resource_kind  TEXT,
  resource_id    TEXT,
  granted_at     INTEGER NOT NULL,
  expires_at     INTEGER,
  PRIMARY KEY (subject_id, permission, resource_kind, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_gate_permissions_subject
  ON gate_permissions (subject_id);

CREATE TABLE IF NOT EXISTS gate_registry_snapshot (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  json       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Seed with permissive bootstrap policies so the first request after
-- migrate does not hit a "default deny" wall before an admin can write
-- policies. The seeds are narrow: they allow anon GET to
-- /v1/api/health and /v1/api/version only. Everything else still denies
-- by default.
INSERT OR IGNORE INTO gate_policies
  (id, description, direction, action, subject_json, resource_json, effect,
   reason_code, priority, enabled, created_at, updated_at)
VALUES
  ('bootstrap.health',
   'allow anonymous health probes',
   'inbound', 'http.request',
   json('{"kind":"anon"}'),
   json('{"kind":"path","method":"GET","pattern":"/v1/api/health"}'),
   'allow', 'bootstrap_health', 10, 1,
   (unixepoch() * 1000), (unixepoch() * 1000)),
  ('bootstrap.version',
   'allow anonymous version probe',
   'inbound', 'http.request',
   json('{"kind":"anon"}'),
   json('{"kind":"path","method":"GET","pattern":"/v1/api/version"}'),
   'allow', 'bootstrap_version', 10, 1,
   (unixepoch() * 1000), (unixepoch() * 1000));
