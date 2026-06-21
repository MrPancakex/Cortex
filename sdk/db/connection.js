import path from 'node:path';
import fs from 'node:fs';
import { Database } from 'bun:sqlite';
import { resolveStateRoot } from '../../core/constants/index.js';
import { swallow } from '../errors/index.js';

let instance = null;

function resolvePath(override) {
  return override || process.env.CORTEX_DB_PATH || path.join(resolveStateRoot(), 'cortex.db');
}

function applyPragmas(db) {
  // bun:sqlite exposes pragmas via run/query — use run() for settings that
  // don't return a value and query() + .get() when we want to read the
  // current setting back.
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA synchronous = NORMAL');
  db.run('PRAGMA foreign_keys = ON');
  db.run('PRAGMA busy_timeout = 5000');
}

export function getDb({ path: override } = {}) {
  if (instance) return instance;
  const file = resolvePath(override);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  instance = new Database(file);
  applyPragmas(instance);
  return instance;
}

export function closeDb() {
  try {
    instance?.close();
  } catch (err) {
    swallow('db.close_failed', err);
  }
  instance = null;
}

export function withTransaction(fn) {
  const db = getDb();
  const tx = db.transaction(fn);
  return tx();
}

/**
 * Read-only access to the current PRAGMA value. Pragma rows from bun:sqlite
 * arrive shaped as `{ <pragma_name>: value }`, but we'd rather not assume
 * the exact key casing — so pull the value explicitly by key when we have
 * it, and fall back to the first column otherwise.
 */
export function readPragma(name) {
  const db = getDb();
  const row = db.query(`PRAGMA ${name}`).get();
  if (!row) return null;
  if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  const keys = Object.keys(row);
  return keys.length ? row[keys[0]] : null;
}
