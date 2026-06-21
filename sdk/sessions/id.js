/**
 * Session-slot id formatting + reverse lookup. Lifted from the legacy
 * hook/CLI surface per Rule 1, with `resolveSessionId` consolidating
 * what used to be `.claude/hooks/lib/session-resolve.sh`.
 *
 * Slot 1 keeps the bare base id so the first session of `nova` is
 * addressable as `nova`; slot N≥2 appends `-N`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { swallow } from '../errors/index.js';

/**
 * @param {string} baseId  non-empty agent base id
 * @param {number} n       positive integer slot number
 * @returns {string}       base id for n=1, '<baseId>-N' for n>=2
 */
export function formatSessionId(baseId, n) {
  if (typeof baseId !== 'string' || baseId.length === 0) {
    throw new Error('formatSessionId: baseId must be a non-empty string');
  }
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`formatSessionId: n must be a positive integer, got ${n}`);
  }
  return n === 1 ? baseId : `${baseId}-${n}`;
}

/**
 * Reverse-lookup: given a pid (typically process.pid) and a base agent,
 * find the lease file that records that pid and return its canonical
 * session id. Returns { sessionId: baseId, n: null, found: false } when
 * no matching lease is found OR the runDir can't be scanned — callers
 * get a safe default and can branch on the `found` flag.
 *
 * Best-effort: unreadable / unparseable leases are skipped (not fatal)
 * so a single bad file doesn't shadow a valid match elsewhere in the
 * same directory. This also covers the mid-write race — a producer that
 * has opened the lease file but hasn't fsync'd the JSON payload yet will
 * surface as a SyntaxError on parse; the next call (after the producer
 * commits) observes the completed lease.
 *
 * @param {string} runDir
 * @param {string} baseId
 * @param {number} pid
 * @returns {{ sessionId: string, n: number | null, found: boolean }}
 */
export function resolveSessionId(runDir, baseId, pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { sessionId: baseId, n: null, found: false };
  }
  let names = [];
  try {
    names = readdirSync(runDir);
  } catch (err) {
    swallow('sessions.resolve_readdir_failed', err);
    return { sessionId: baseId, n: null, found: false };
  }
  const prefix = `${baseId}-`;
  const suffix = '.session.json';
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
    const slotText = name.slice(prefix.length, -suffix.length);
    const n = parseInt(slotText, 10);
    if (!Number.isInteger(n) || n < 1) continue;
    let lease = null;
    try {
      lease = JSON.parse(readFileSync(join(runDir, name), 'utf8'));
    } catch (err) {
      // Unreadable or unparseable — best-effort discovery skips and
      // continues; the reaper is responsible for cleanup.
      swallow('sessions.resolve_lease_unreadable', err);
      continue;
    }
    if (lease && Number.isInteger(lease.pid) && lease.pid === pid) {
      return {
        sessionId: lease.session_id || formatSessionId(baseId, n),
        n,
        found: true,
      };
    }
  }
  return { sessionId: baseId, n: null, found: false };
}
