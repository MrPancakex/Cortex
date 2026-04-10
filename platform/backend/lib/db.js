import Database from 'better-sqlite3';
import { loadConfig } from './config.js';
import path from 'node:path';
import fs from 'node:fs';

const config = loadConfig();
const dbDir = path.join(config.paths.data, 'backend');

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

export const db = new Database(path.join(dbDir, 'backend.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS system_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  type TEXT NOT NULL,
  source TEXT,
  message TEXT,
  metadata TEXT DEFAULT '{}'
);
`);

export function logEvent(type, source, message, metadata = {}) {
  const stmt = db.prepare('INSERT INTO system_events (type, source, message, metadata) VALUES (?, ?, ?, ?)');
  stmt.run(type, source, message, JSON.stringify(metadata));
}
