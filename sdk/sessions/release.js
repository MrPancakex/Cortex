/**
 * Release a session-slot lease. Lifted from services/gateway/lib/session.js
 * per Rule 1.
 *
 * Two entry points:
 *   releaseSessionSlot(runDir, baseId, n, pid?)
 *     The owning process releases its own lease. STRICTER than legacy:
 *     refuses the release on ANY ambiguous state (unparseable content,
 *     unreadable file, pid mismatch) so a crashed-writer remnant can't
 *     cause cross-owner deletion. Callers that want the "sweep anything
 *     in this slot" semantics should call releaseSessionSlotIfDead.
 *     Outcomes:
 *       released: true                         — lease removed cleanly
 *       released: false, reason: not_found     — slot already gone
 *       released: false, reason: pid_mismatch  — lease belongs to someone else
 *       released: false, reason: corrupt       — unparseable; refer to reaper
 *       released: false, reason: read_failed   — cross-user or transient IO
 *
 *   releaseSessionSlotIfDead(runDir, baseId, n)
 *     Used by the SessionEnd hook as a backstop when the owning stdio
 *     process didn't clean up its own lease. Defers on unreadable leases
 *     (cross-user EACCES would otherwise let a reaper collapse live
 *     slots) and only sweeps when the recorded pid is confirmed dead or
 *     the file is unparseable crashed-writer debris.
 *     Outcomes:
 *       released: true                       — dead-pid lease swept
 *       released: true, reason: corrupt      — unparseable swept
 *       released: false, reason: pid_alive   — owner still running, defer
 *       released: false, reason: read_failed — cross-user or transient IO
 *       released: false, reason: not_found   — already gone (race)
 */

import { leasePath } from './paths.js';
import { isLeasePidAlive } from './lease.js';
import { readLeaseFile, sweepLease } from './fs-helpers.js';
import { swallow } from '../errors/index.js';

export function releaseSessionSlot(runDir, baseId, n, pid = process.pid) {
  const filePath = leasePath(runDir, baseId, n);
  const read = readLeaseFile(filePath);

  if (read.ioError) {
    if (read.ioError.code === 'ENOENT') return { released: false, reason: 'not_found' };
    // Anything else (EACCES, EIO, EMFILE, ...) tells us nothing about
    // content or ownership — refuse rather than sweep blind.
    return { released: false, reason: 'read_failed' };
  }
  if (read.syntaxError) {
    // Surface for operator visibility, then refuse — legacy swept the
    // file anyway, but that path let a crashed-writer remnant take down
    // a slot that may have been re-claimed by a different owner. The
    // reaper (releaseSessionSlotIfDead) is responsible for corrupt sweeps.
    swallow('sessions.lease_corrupt', read.syntaxError);
    return { released: false, reason: 'corrupt' };
  }
  if (
    read.value
    && Number.isInteger(read.value.pid)
    && read.value.pid !== pid
  ) {
    return { released: false, reason: 'pid_mismatch' };
  }

  sweepLease(filePath);
  return { released: true };
}

export function releaseSessionSlotIfDead(runDir, baseId, n) {
  const filePath = leasePath(runDir, baseId, n);
  const read = readLeaseFile(filePath);

  if (read.ioError) {
    if (read.ioError.code === 'ENOENT') return { released: false, reason: 'not_found' };
    // Cross-user or transient read failure — defer. Sweeping blind here
    // is how a reaper collapses live leases owned by another account.
    return { released: false, reason: 'read_failed' };
  }
  if (read.syntaxError) {
    swallow('sessions.lease_corrupt', read.syntaxError);
    sweepLease(filePath);
    return { released: true, reason: 'corrupt' };
  }

  if (isLeasePidAlive(read.value)) {
    return { released: false, reason: 'pid_alive' };
  }

  sweepLease(filePath);
  return { released: true };
}
