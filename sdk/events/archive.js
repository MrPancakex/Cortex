/**
 * Optional gzip JSONL archive for events being vacuumed. When
 * CORTEX_EVENT_ARCHIVE is truthy, `archiveRows(rows)` writes a gzipped
 * JSON-lines file to CORTEX_EVENT_ARCHIVE_DIR (or <state-root>/archive/
 * by default) before `vacuum.js` deletes them from the table.
 *
 * File naming: `events-<fromSeq>-<toSeq>-<epochMs>.jsonl.gz`. The seq
 * range lets an operator grep the archive set for a specific event by
 * the cursor they saw in-flight.
 */

import path from 'node:path';
import zlib from 'node:zlib';
import { writeFileSync, chmodSync } from 'node:fs';
import { resolveStateRoot } from '../../core/constants/index.js';
import { ensureDir } from '../fs/index.js';
import { swallow } from '../errors/index.js';

export function archiveEnabled() {
  return process.env.CORTEX_EVENT_ARCHIVE === '1'
    || process.env.CORTEX_EVENT_ARCHIVE === 'true';
}

export function archiveDir() {
  if (process.env.CORTEX_EVENT_ARCHIVE_DIR) return process.env.CORTEX_EVENT_ARCHIVE_DIR;
  return path.join(resolveStateRoot(), 'archive', 'events');
}

/**
 * Archive a batch of event rows. Returns the file path written, or null
 * if archiving is disabled / rows is empty / the write failed.
 */
export function archiveRows(rows) {
  if (!archiveEnabled()) return null;
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const dir = archiveDir();
  try {
    ensureDir(dir);
  } catch (err) {
    swallow('events.archive_dir_failed', err);
    return null;
  }

  const fromSeq = Number(rows[0].seq);
  const toSeq = Number(rows[rows.length - 1].seq);
  const file = path.join(dir, `events-${fromSeq}-${toSeq}-${Date.now()}.jsonl.gz`);

  try {
    const body = rows.map((r) => JSON.stringify(r)).join('\n');
    const gz = zlib.gzipSync(Buffer.from(`${body}\n`, 'utf8'));
    writeFileSync(file, gz, { mode: 0o600 });
    // writeFileSync's `mode` only applies on file CREATE; chmod after
    // the fact to guarantee the intended mode even if the path was
    // pre-existing (unlikely given the timestamped filename, but
    // defense-in-depth).
    try {
      chmodSync(file, 0o600);
    } catch (err) {
      swallow('events.archive_chmod_failed', err);
    }
    return file;
  } catch (err) {
    swallow('events.archive_write_failed', err);
    return null;
  }
}
