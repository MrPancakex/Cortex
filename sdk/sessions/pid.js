/**
 * PID liveness + start-time probes. Lifted from services/gateway/lib/session.js
 * per Rule 1.
 *
 * - readPidStartTime(pid): raw field-22 ("starttime") from /proc/<pid>/stat,
 *   returned as an opaque string so callers can compare identity without
 *   precision-loss games. Linux-only; returns null on other platforms, when
 *   /proc is unavailable, or when the pid has already exited.
 * - isPidAlive(pid): signal-zero liveness check. EPERM means the pid exists
 *   but cross-user — callers MUST treat that as alive, because treating
 *   cross-user EPERM as dead is how a reaper silently sweeps live leases
 *   owned by another account.
 */

import { readFileSync } from 'node:fs';

export function readPidStartTime(pid) {
  if (process.env.CORTEX_FORCE_NO_PROC === '1') return null;
  if (process.platform !== 'linux') return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm is parenthesized and may contain spaces/parens — split after the
    // last ')'. Field 22 (starttime) is index 19 in the post-comm array.
    const after = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return after[19] || null;
    // eslint-disable-next-line cortex-local/catch-has-metric -- pid probe: null on any read/parse failure is the documented contract; counter bump would fire on every dead-pid check.
  } catch {
    return null;
  }
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = pid exists, cross-user; only ESRCH means truly dead.
    if (err?.code === 'EPERM') return true;
    return false;
  }
}
