/**
 * Events retention job. Deletes rows older than `retentionMs` on a
 * configurable cadence. When CORTEX_EVENT_ARCHIVE is enabled, the rows
 * are gzipped to the archive directory before deletion.
 *
 * `startVacuum()` returns a stop handle so the caller (tests, gateway
 * shutdown) can cleanly tear down the interval.
 */

import { getDb } from '../db/index.js';
import { swallow } from '../errors/index.js';
import { archiveRows, archiveEnabled } from './archive.js';

const DEFAULT_INTERVAL_MS = 60 * 60_000;          // 1 hour
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60_000; // 30 days
const SELECT_BATCH_LIMIT = 5000;

/**
 * Perform one sweep. Selects rows with ts < cutoff (up to the batch
 * limit), optionally archives them, then DELETEs the EXACT selected
 * seqs via an IN-list. Returns `{ archived, deleted }`.
 *
 * DELETE-by-IN rather than DELETE-by-BETWEEN(min, max) is deliberate:
 * events can land with caller-overridden `meta.ts` values (a Phase 4+
 * replay, or a client clock skew), so the ts ordering does NOT always
 * match seq ordering. A BETWEEN range between the first and last
 * selected seqs could catch interleaved rows whose ts is NEWER than
 * the cutoff — silent data loss on the retention boundary.
 *
 * SQLite's default SQLITE_LIMIT_VARIABLE_NUMBER is 32,766; the batch
 * limit of 5,000 is comfortably under.
 *
 * Archive-failure policy: if `archiveEnabled()` is true and
 * `archiveRows()` throws, the exception propagates out of this
 * function (the surrounding `startVacuum` tick catches it via
 * swallow). The DELETE never runs, rows stay in the table, and the
 * next tick retries. This is intentional — we do not delete data we
 * couldn't archive. A refactor that wraps `archiveRows` in a
 * try/catch here must preserve that contract.
 */
export function runVacuumOnce({ retentionMs = DEFAULT_RETENTION_MS, now = Date.now() } = {}) {
  const cutoff = now - retentionMs;
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM events WHERE ts < ? ORDER BY seq ASC LIMIT ?')
    .all(cutoff, SELECT_BATCH_LIMIT);
  if (rows.length === 0) return { archived: 0, deleted: 0 };

  let archivedFile = null;
  if (archiveEnabled()) {
    archivedFile = archiveRows(rows);
  }

  let deleted = 0;
  try {
    const seqs = rows.map((r) => Number(r.seq));
    const placeholders = seqs.map(() => '?').join(',');
    const info = db
      .prepare(`DELETE FROM events WHERE seq IN (${placeholders})`)
      .run(...seqs);
    deleted = Number(info.changes);
  } catch (err) {
    swallow('events.vacuum_delete_failed', err);
  }

  return { archived: archivedFile ? rows.length : 0, deleted };
}

/**
 * Start the retention loop. Returns `{ stop() }` so callers can shut
 * the interval down. Fires once immediately so a long-idle process
 * doesn't wait a full interval before its first sweep.
 */
export function startVacuum({ intervalMs = DEFAULT_INTERVAL_MS, retentionMs = DEFAULT_RETENTION_MS } = {}) {
  const tick = () => {
    try {
      runVacuumOnce({ retentionMs });
    } catch (err) {
      swallow('events.vacuum_tick_failed', err);
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  // Node/Bun: don't hold the event loop open just for the vacuum tick.
  if (typeof timer.unref === 'function') timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
