import { getDb } from '../db/index.js';
import { swallow } from '../errors/index.js';

export function registerAgent({
  id,
  name,
  kind,
  capabilities = [],
  model = null,
  provider = null,
  metadata = {},
}) {
  const db = getDb();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO agents (id, name, kind, status, capabilities, model, provider, metadata, registered_at, last_heartbeat)
    VALUES (?, ?, ?, 'online', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      kind = excluded.kind,
      capabilities = excluded.capabilities,
      model = excluded.model,
      provider = excluded.provider,
      metadata = excluded.metadata,
      status = 'online',
      last_heartbeat = excluded.last_heartbeat
  `);
  stmt.run(
    id,
    name,
    kind,
    JSON.stringify(capabilities),
    model,
    provider,
    JSON.stringify(metadata),
    now,
    now,
  );
  return findAgent(id);
}

export function findAgent(id) {
  try {
    const row = getDb().prepare('SELECT * FROM agents WHERE id = ?').get(id);
    return row ? hydrate(row) : null;
  } catch (err) {
    swallow('auth.find_agent_failed', err);
    return null;
  }
}

export function listAgents({ status, kind } = {}) {
  const clauses = [];
  const args = [];
  if (status) {
    clauses.push('status = ?');
    args.push(status);
  }
  if (kind) {
    clauses.push('kind = ?');
    args.push(kind);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = getDb()
    .prepare(`SELECT * FROM agents ${where} ORDER BY registered_at DESC`)
    .all(...args);
  return rows.map(hydrate);
}

export function revokeAgent(id) {
  getDb().prepare('UPDATE agents SET status = ? WHERE id = ?').run('disabled', id);
}

function hydrate(row) {
  return {
    ...row,
    capabilities: safeParse(row.capabilities, []),
    metadata: safeParse(row.metadata, {}),
  };
}

function safeParse(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    swallow('auth.safe_parse_failed', err);
    return fallback;
  }
}
