/**
 * Atomic event write + in-process fanout. Every `emit()` goes through
 * here: the envelope is inserted inside a transaction, and only after
 * the commit returns do we call `bus.publish(event)` so a subscriber
 * cannot observe an event that failed to persist.
 *
 * On insert failure (disk full, db corrupt, UNIQUE violation from a
 * replayed recovery envelope), behavior branches:
 *   - SQLITE_CONSTRAINT_UNIQUE: treat as idempotent replay; still fan
 *     out in-process so live subscribers see the event, but don't
 *     buffer again.
 *   - any other error: bump `events.emit_failed`, buffer the envelope
 *     to event-recovery.jsonl, and rethrow. The caller decides whether
 *     the failure is fatal at its own boundary.
 */

import { getDb, withTransaction } from '../db/index.js';
import { swallow } from '../errors/index.js';
import { bus } from './bus.js';
import { bufferEnvelope } from './recovery.js';

function isUniqueConstraint(err) {
  const code = err?.code || err?.errno;
  if (typeof code === 'string') return code.includes('SQLITE_CONSTRAINT');
  const msg = err?.message || '';
  return msg.includes('UNIQUE') || msg.includes('SQLITE_CONSTRAINT');
}

/**
 * @param {object} envelope  already-validated event envelope
 * @param {{ fromRecovery?: boolean }} [opts]
 *   set to `true` by the boot-time recovery drain so a still-failing
 *   replay does NOT re-append to event-recovery.jsonl (the drain already
 *   holds that envelope; re-buffering would be redundant I/O at best
 *   and racy with the drain's own rewrite at worst — see recovery.js).
 * @returns {{ seq: number | null, duplicate: boolean }}
 *
 * Uses the singleton db via getDb() — sharing the singleton with
 * withTransaction() matters because SQLite's transaction state is
 * per-connection and a prepared statement compiled on one handle
 * cannot be executed inside a transaction opened on another.
 *
 * Note on `seq: null` in the UNIQUE-replay branch: if the row was
 * vacuumed between the INSERT failure and the SELECT, `seq` is null.
 * In-process subscribers that do their own cursor math MUST be prepared
 * for that (null > N is false, so naive `if (event.seq > lastSeen)`
 * silently skips the duplicate — which is usually correct for dupes).
 */
export function writeAndNotify(envelope, opts = {}) {
  const db = getDb();
  let seq = null;
  let duplicate = false;
  try {
    withTransaction(() => {
      const stmt = db.prepare(
        `INSERT INTO events (id, subject, ts, source, task_id, session_id, trace_id, payload, v)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const info = stmt.run(
        envelope.id,
        envelope.subject,
        envelope.ts,
        envelope.source,
        envelope.task_id ?? null,
        envelope.session_id ?? null,
        envelope.trace_id ?? null,
        JSON.stringify(envelope.payload),
        envelope.v,
      );
      seq = Number(info.lastInsertRowid);
    });
  } catch (err) {
    if (isUniqueConstraint(err)) {
      // Replay of an envelope whose row already landed — idempotent by
      // design. Fan out to live subscribers so a reconnect-after-restart
      // still sees the event, then return with duplicate: true.
      duplicate = true;
      const existing = db
        .prepare('SELECT seq FROM events WHERE id = ?')
        .get(envelope.id);
      seq = existing ? Number(existing.seq) : null;
    } else {
      swallow('events.emit_failed', err);
      if (!opts.fromRecovery) bufferEnvelope(envelope);
      throw err;
    }
  }

  // Only fan out after the transaction commits (or after a confirmed
  // duplicate). A subscriber cannot observe an event that isn't durable.
  bus.publish({ ...envelope, seq });
  return { seq, duplicate };
}
