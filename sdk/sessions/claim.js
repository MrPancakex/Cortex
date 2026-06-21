/**
 * Claim the next free session slot for a base agent. Lifted from
 * services/gateway/lib/session.js per Rule 1.
 *
 * Race-safe: prunes dead leases, finds the lowest free slot number, then
 * attempts O_EXCL-create. EEXIST → bump the candidate and retry; any
 * other error propagates. Defeats umask with an explicit chmod to 0o640
 * so a cross-user gateway (same group as the gateway process) can
 * actually read the lease to verify liveness, instead of catching EACCES
 * and mistaking readability for corruption.
 *
 * Returns { sessionId, n } — e.g. { sessionId: 'nova', n: 1 } or
 * { sessionId: 'nova-2', n: 2 }.
 */

import {
  mkdirSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  chmodSync,
  rmSync,
} from 'node:fs';
import { formatSessionId } from './id.js';
import { leasePath } from './paths.js';
import { readPidStartTime } from './pid.js';
import { getActiveSlots } from './lease.js';
import { swallow } from '../errors/index.js';

// EEXIST retry budget — should vastly exceed any realistic concurrent session
// count. Each loop iteration calls openSync('wx', ...), which is POSIX
// O_EXCL: the first racer wins, every other racer gets EEXIST and bumps the
// candidate slot. MAX_ATTEMPTS is a safety bound against a runaway loop, not
// a cap on concurrent slots.
const MAX_ATTEMPTS = 1024;

export function claimSessionSlot(runDir, baseId, pid = process.pid) {
  try {
    mkdirSync(runDir, { recursive: true });
  } catch (err) {
    // Recursive+existing is fine; surface any real permission error via
    // swallow so /health records it but don't abort here — the openSync
    // below will throw the authoritative error if the dir is unusable.
    swallow('sessions.claim_mkdir_failed', err);
  }

  const active = getActiveSlots(runDir, baseId);
  const usedSlots = new Set(active.map((s) => s.n));
  let candidate = 1;
  while (usedSlots.has(candidate)) candidate += 1;

  // Read the pid start-time BEFORE entering the O_EXCL critical window.
  // A /proc read inside the window extends the time the lease file exists
  // with `wx` semantics but empty contents.
  const pidStartTime = readPidStartTime(pid);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const filePath = leasePath(runDir, baseId, candidate);
    let fd;
    try {
      fd = openSync(filePath, 'wx', 0o640);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      candidate += 1;
      continue;
    }
    let sweepOnFailure = true;
    try {
      // Defeat umask — openSync's mode is masked by the process umask, so a
      // caller under umask 077 would land on 0o600 despite requesting 0o640,
      // stripping the group-read bit the cross-user reaper needs to verify
      // liveness. Chmod after the fact to force the intended mode.
      try {
        chmodSync(filePath, 0o640);
      } catch (err) {
        swallow('sessions.claim_chmod_failed', err);
      }
      const sessionId = formatSessionId(baseId, candidate);
      const payload = `${JSON.stringify({
        base_id: baseId,
        session_id: sessionId,
        pid,
        pid_start_time: pidStartTime,
        claimed_at: new Date().toISOString(),
      })}\n`;
      writeSync(fd, payload);
      fsyncSync(fd);
      sweepOnFailure = false;
      return { sessionId, n: candidate };
    } finally {
      closeSync(fd);
      // If writeSync/fsyncSync threw, the lease file exists but is empty
      // or partial. Leaving it poisons the slot for LEASE_POISON_MAX_AGE_MS.
      // Sweep it and let the caller surface the original I/O error.
      if (sweepOnFailure) {
        try {
          rmSync(filePath, { force: true });
        } catch (err) {
          swallow('sessions.claim_cleanup_failed', err);
        }
      }
    }
  }
  throw new Error(
    `could not claim session slot for ${baseId} after ${MAX_ATTEMPTS} attempts`,
  );
}
