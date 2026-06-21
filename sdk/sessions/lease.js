/**
 * Lease-directory scan + per-lease liveness check. Lifted from
 * services/gateway/lib/session.js per Rule 1.
 *
 * The hard-won rule encoded here (see prior incident memory): ONLY a
 * SyntaxError on a readable file tells us the CONTENT is bad. Any other
 * read failure (EACCES, EPERM, EIO, EBUSY, ENFILE, EMFILE, ...) carries
 * zero information about integrity — so the lease MUST be preserved.
 * Blind-sweeping an EACCES lease is how a cross-user reaper collapses
 * every live session to slot 1.
 */

import { readdirSync } from 'node:fs';
import { LEASE_POISON_MAX_AGE_MS } from '@cortex/core/constants';
import { formatSessionId } from './id.js';
import { readPidStartTime, isPidAlive } from './pid.js';
import { readLeaseFile, getLeaseAgeMs, sweepLease } from './fs-helpers.js';

export function isLeasePidAlive(lease) {
  if (!Number.isInteger(lease?.pid)) return false;
  if (!isPidAlive(lease.pid)) return false;
  if (lease.pid_start_time != null) {
    const current = readPidStartTime(lease.pid);
    // If we can't read the current start time (e.g. /proc race), trust the
    // existence check and keep the lease. A mismatch, however, means the
    // PID has been recycled under a new process.
    if (current != null && current !== lease.pid_start_time) return false;
  }
  return true;
}

export function getActiveSlots(runDir, baseId) {
  const prefix = `${baseId}-`;
  const suffix = '.session.json';
  const active = [];

  for (const name of readdirSync(runDir)) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
    const slotText = name.slice(prefix.length, -suffix.length);
    const n = parseInt(slotText, 10);
    if (!Number.isInteger(n) || n < 1) continue;

    const filePath = `${runDir}/${name}`;
    const read = readLeaseFile(filePath);

    if (read.ioError) {
      // Read failed — no info about content integrity. Preserve the slot
      // as occupied with pid:0 so a cross-user reaper never collapses a
      // live lease it simply can't read.
      active.push({ n, pid: 0, sessionId: formatSessionId(baseId, n) });
      continue;
    }

    if (read.syntaxError) {
      // Readable but unparseable. Either a lease mid-write (O_EXCL opened,
      // payload not yet flushed) or crashed-writer debris. Use mtime to
      // tell them apart — young files are presumed in-progress; old ones
      // get swept.
      const ageMs = getLeaseAgeMs(filePath) ?? 0;
      if (ageMs > LEASE_POISON_MAX_AGE_MS) {
        sweepLease(filePath);
        continue;
      }
      active.push({ n, pid: 0, sessionId: formatSessionId(baseId, n) });
      continue;
    }

    const lease = read.value;
    if (!isLeasePidAlive(lease)) {
      sweepLease(filePath);
      continue;
    }

    active.push({
      n,
      pid: lease.pid,
      sessionId: lease.session_id || formatSessionId(baseId, n),
    });
  }

  active.sort((a, b) => a.n - b.n);
  return active;
}
