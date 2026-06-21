-- Phase 11 — plugins table.
--
-- Single source of truth for the plugin plane. Written exclusively by
-- services/gateway/plugins/registry.js and services/gateway/plugins/
-- supervisor.js via the prepared statements in statements.js.
--
-- Every plugin row owns its full manifest (manifest_json) so the registry
-- can re-validate on reboot without re-reading from disk. The supervisor
-- updates `state`, `pid`, `last_health_at`, `last_error`, and
-- `restart_count` in place.
--
-- Migration is applied inside runner.withTransaction(); MUST NOT contain
-- its own BEGIN/COMMIT.

CREATE TABLE IF NOT EXISTS plugins (
  name             TEXT PRIMARY KEY,
  version          TEXT NOT NULL,
  kind             TEXT NOT NULL,
  runtime          TEXT NOT NULL,
  entry            TEXT NOT NULL,

  manifest_json    TEXT NOT NULL,
  trust_key_id     TEXT,
  signed           INTEGER NOT NULL DEFAULT 0,
  enabled          INTEGER NOT NULL DEFAULT 1,

  state            TEXT DEFAULT 'stopped',
  pid              INTEGER,
  last_health_at   INTEGER,
  last_error       TEXT,
  restart_count    INTEGER NOT NULL DEFAULT 0,

  registered_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at       INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_plugins_enabled ON plugins(enabled);
CREATE INDEX IF NOT EXISTS idx_plugins_kind    ON plugins(kind);
CREATE INDEX IF NOT EXISTS idx_plugins_state   ON plugins(state);
