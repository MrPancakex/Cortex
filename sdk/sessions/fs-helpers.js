/**
 * Shared filesystem helpers specific to session leases. Factored out of
 * lease.js / claim.js / release.js so each can stay narrow and so the
 * three distinct error-handling shapes below are defined in one place.
 *
 * Three primitives, all silent on failure (they return structured results
 * instead of throwing so the caller can decide discipline):
 *
 *   readLeaseFile(path)
 *     -> { value, ioError, syntaxError }
 *     exactly one of the three is set. A SyntaxError means the file was
 *     readable but the JSON parse failed (crashed-writer debris OR a
 *     lease mid-write). Any other error means the read itself failed
 *     (EACCES on cross-user, EIO, EMFILE, etc.) — which tells us nothing
 *     about the content's integrity, so callers must NOT sweep on that.
 *
 *   getLeaseAgeMs(path)
 *     -> number | null
 *     ms since mtime, or null if stat failed (treat as "fresh" by default
 *     — safer than assuming old).
 *
 *   sweepLease(path)
 *     -> boolean (true if the unlink call returned)
 *     rm with force:true so missing-file races are silent. Any other
 *     error is funneled to swallow('sessions.lease_sweep_failed') so a
 *     stuck lease surfaces on /health without crashing the reaper.
 */

import { readFileSync, rmSync, statSync } from 'node:fs';
import { swallow } from '../errors/index.js';

/**
 * @param {string} path lease file path
 * @returns {{ value?: unknown, ioError?: Error, syntaxError?: Error }}
 *   exactly one of the three fields is set
 */
export function readLeaseFile(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    return { ioError: err };
  }
  try {
    return { value: JSON.parse(raw) };
  } catch (err) {
    return { syntaxError: err };
  }
}

export function getLeaseAgeMs(path) {
  try {
    return Date.now() - statSync(path).mtimeMs;
    // eslint-disable-next-line cortex-local/catch-has-metric -- lease-age probe: null on stat failure is semantic ("treat as fresh"); counter would fire on every concurrent-sweep race.
  } catch {
    return null;
  }
}

export function sweepLease(path) {
  try {
    rmSync(path, { force: true });
    return true;
  } catch (err) {
    swallow('sessions.lease_sweep_failed', err);
    return false;
  }
}
