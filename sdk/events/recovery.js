/**
 * Event-recovery buffer. When `durable-write.js` fails to INSERT an event
 * (disk full, corrupt db, transient bun:sqlite error), the envelope is
 * appended to `event-recovery.jsonl` instead of silently dropping. On
 * next boot — or when the caller explicitly calls `drain()` — the buffer
 * is replayed and each line re-emitted.
 *
 * Idempotency is provided by the envelope's `id` UUID + the events
 * table's UNIQUE constraint on id: replaying a buffered event that
 * already landed is a no-op with a SQLITE_CONSTRAINT error that we
 * interpret as "already applied" rather than an actual failure.
 *
 * Concurrency discipline:
 *   - `drainRecoveryBuffer` serializes via a module-level promise lock
 *     so two callers can't clobber each other's temp files.
 *   - The drain "renames the file in" — moves `event-recovery.jsonl` to
 *     a unique per-drain path BEFORE reading. Concurrent `bufferEnvelope`
 *     calls during the drain land in a fresh `event-recovery.jsonl`
 *     that the drain never touches. At the end we `appendFileSync` any
 *     `kept` envelopes back onto the (potentially concurrent-populated)
 *     live file — merges without data loss because both rename and
 *     append are atomic at the filesystem layer.
 */

import path from 'node:path';
import {
  readFileSync,
  appendFileSync,
  existsSync,
  renameSync,
  unlinkSync,
  chmodSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolveStateRoot } from '../../core/constants/index.js';
import { ensureDir } from '../fs/index.js';
import { swallow } from '../errors/index.js';

const DEFAULT_FILE = 'event-recovery.jsonl';

export function recoveryFilePath() {
  if (process.env.CORTEX_EVENT_RECOVERY_FILE) return process.env.CORTEX_EVENT_RECOVERY_FILE;
  return path.join(resolveStateRoot(), DEFAULT_FILE);
}

/**
 * Append one envelope to the recovery buffer. Best-effort — if the
 * append itself fails (no disk, no perms), bump the counter and return
 * false so the caller can decide whether to rethrow or accept loss.
 *
 * The `{ mode: 0o600 }` only takes effect when appendFileSync creates
 * the file; if the file already exists with wider perms an explicit
 * chmod is applied as belt-and-suspenders. The state-root directory
 * itself is 0o700 so this is defense-in-depth.
 */
export function bufferEnvelope(envelope) {
  const file = recoveryFilePath();
  try {
    ensureDir(path.dirname(file));
    const existed = existsSync(file);
    appendFileSync(file, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    if (existed) {
      try {
        chmodSync(file, 0o600);
      } catch (err) {
        swallow('events.recovery_chmod_failed', err);
      }
    }
    return true;
  } catch (err) {
    swallow('events.recovery_buffer_failed', err);
    return false;
  }
}

// Module-level drain lock. When a drain is in flight, subsequent callers
// get the same promise — guarantees single-writer semantics on the
// rename/append sequence without requiring an external lockfile.
let _drainInFlight = null;

/**
 * Drain the recovery buffer by invoking `replay(envelope)` for each
 * line. Successful replays are removed; failed replays are merged back
 * into the live buffer for a future drain.
 *
 * Serialized: if a drain is already running, the second caller awaits
 * the first. Concurrent `bufferEnvelope()` calls during a drain land
 * in a fresh `event-recovery.jsonl` that the drain's rename left
 * behind — they survive unharmed.
 *
 * @param {(envelope: unknown) => Promise<boolean> | boolean} replay
 *   returns true when the envelope was re-applied (or already existed),
 *   false to keep the envelope in the buffer for next time
 * @returns {Promise<{ drained: number, kept: number }>}
 */
export function drainRecoveryBuffer(replay) {
  if (_drainInFlight) return _drainInFlight;
  _drainInFlight = (async () => {
    try {
      return await _doDrain(replay);
    } finally {
      _drainInFlight = null;
    }
  })();
  return _drainInFlight;
}

async function _doDrain(replay) {
  const file = recoveryFilePath();
  if (!existsSync(file)) return { drained: 0, kept: 0 };

  // Rename-in: move the current buffer aside so concurrent bufferEnvelope
  // writes go to a fresh file. Uniqueness suffix prevents collision with
  // a leftover `.draining-*` file from a prior crashed drain in the same
  // pid and with any other concurrent drain (the lock above already
  // serializes within-process, so this is belt-and-suspenders for
  // multi-process cases).
  const drainingFile = `${file}.draining-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    renameSync(file, drainingFile);
  } catch (err) {
    // ENOENT: file disappeared between existsSync and rename — nothing to do.
    if (err?.code === 'ENOENT') return { drained: 0, kept: 0 };
    swallow('events.recovery_rename_in_failed', err);
    return { drained: 0, kept: 0 };
  }

  let raw;
  try {
    raw = readFileSync(drainingFile, 'utf8');
  } catch (err) {
    swallow('events.recovery_read_failed', err);
    // Best-effort put-it-back so the data isn't orphaned.
    try {
      renameSync(drainingFile, file);
    } catch (putbackErr) {
      swallow('events.recovery_putback_failed', putbackErr);
    }
    return { drained: 0, kept: 0 };
  }

  const lines = raw.split('\n').filter((l) => l.length > 0);
  const kept = [];
  let drained = 0;
  for (const line of lines) {
    let envelope;
    try {
      envelope = JSON.parse(line);
    } catch (err) {
      // Unparseable line is irrecoverable — surface the corruption and drop.
      swallow('events.recovery_line_corrupt', err);
      continue;
    }
    let ok = false;
    try {
      ok = await replay(envelope);
    } catch (err) {
      swallow('events.recovery_replay_failed', err);
      ok = false;
    }
    if (ok) drained += 1;
    else kept.push(line);
  }

  // Merge kept lines back into the live file, which may now contain
  // concurrently-buffered envelopes that arrived during the drain.
  // appendFileSync is atomic for small writes at the POSIX layer, so
  // we don't corrupt whatever the concurrent writer put there.
  try {
    if (kept.length > 0) {
      const body = kept.map((line) => `${line}\n`).join('');
      appendFileSync(file, body, { mode: 0o600 });
    }
    unlinkSync(drainingFile);
  } catch (err) {
    swallow('events.recovery_file_rewrite_failed', err);
  }

  return { drained, kept: kept.length };
}
