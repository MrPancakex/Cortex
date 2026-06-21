/**
 * Same-base-agent identity comparator.
 *
 * Multiple sessions can be slotted under a single registered agent:
 *   registered base `nova`            → sessions `nova`, `nova-2`, `nova-3`
 *   registered base `codex-worker`    → sessions `codex-worker`, `codex-worker-2`
 *   registered base `my-agent`        → sessions `my-agent`, `my-agent-2`
 *
 * The tricky case is hyphenated base ids. A naive
 * `actor.startsWith(base + '-')` or `split('-')[0]` collapse would wrongly
 * treat:
 *   - `my-agent`      and `my-other-agent`  as the same base ("my")
 *   - `my-agent-2`    and `my-agent-tool`   as the same base ("my-agent")
 * The registered-agents set is the only authoritative source of which prefix
 * is a real base. Server-side callers read it through the registry table;
 * client-side tools may pass the already-fetched set to avoid hand-copying the
 * resolver.
 *
 * `resolveBaseAgent(id)` walks up from the given id, stripping one
 * trailing `-<digits>` segment at a time, and returns the first segment
 * that exists in the `agents` table:
 *   - `nova-3`              → 'nova'         (if nova is registered)
 *   - `nova`                → 'nova'         (strict hit)
 *   - `my-agent-2`          → 'my-agent'     (if my-agent is registered)
 *   - `my-other-agent`      → 'my-other-agent' (strict hit, not 'my')
 *   - `unknown-7`           → 'unknown-7'    (nothing registered; id stands alone)
 *
 * This means two ids only "share a base" when the registry confirms it.
 * Unrelated bases that happen to share a hyphen-separated prefix are kept
 * distinct — which is the whole point of the registry-resolution fix.
 *
 * `sameBaseAgent(a, b)` collapses both via resolveBaseAgent and compares.
 *
 * Dependency note: this module imports from './registry.js' (same plane) for
 * server-side lookups, so Rule 1 (downward-only) stays satisfied — no
 * plane-to-plane crossings.
 */

import { findAgent } from './registry.js';
import { swallow } from '../errors/index.js';

const TRAILING_SLOT = /-(\d+)$/;

/**
 * Resolve an agent id (possibly a session slot) to its registered base.
 *
 * Lookup rule:
 *   1. Trim + reject empty / non-string input (returns null).
 *   2. If the exact id is a registered agent, that IS the base.
 *   3. Else strip the last `-<digits>` segment and re-check. Repeat while
 *      the remainder still has a slot-like suffix.
 *   4. If no ancestor is registered, return the original id unchanged so
 *      callers comparing two unregistered ids still get correct equality
 *      (strict string match) without surprise collapsing.
 *
 * @param {string | null | undefined} agentId
 * @param {Set<string> | null} [registeredBases]
 * @returns {string | null}
 *
 * @example
 *   resolveBaseAgent('nova-3')   // → 'nova'  (if nova is registered)
 *   resolveBaseAgent('nova')     // → 'nova'  (strict hit)
 */
export function resolveBaseAgent(agentId, registeredBases = null) {
  if (typeof agentId !== 'string') return null;
  const trimmed = agentId.trim().toLowerCase();
  if (!trimmed) return null;

  // Step 2: strict registry hit wins, no further peeling. Covers both
  // bare base ids and bases that happen to end in `-<digits>` because an
  // operator named them that way (rare, but valid).
  if (agentExists(trimmed, registeredBases)) return trimmed;

  // Step 3: peel one `-<digits>` segment at a time. We only peel digit
  // tails — a suffix like `-worker` is a legitimate name segment, not a
  // slot number, and we must not strip it. This loop terminates because
  // each peel shortens `current` by at least two characters (the hyphen
  // and one digit).
  let current = trimmed;
  while (TRAILING_SLOT.test(current)) {
    current = current.replace(TRAILING_SLOT, '');
    if (!current) break;
    if (agentExists(current, registeredBases)) return current;
  }

  // Step 4: no registered ancestor. Return the trimmed id so the caller
  // treats it as its own base — two unregistered ids compare as equal only
  // when the strings are identical.
  return trimmed;
}

/**
 * `true` when both ids resolve to the same registered base agent.
 *
 * Defensive on null / non-string inputs: returns false. This matches the
 * conservative contract of the existing tasks/access.js equals shim (deny
 * by default).
 *
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 * @returns {boolean}
 */
export function sameBaseAgent(a, b, registeredBases = null) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (!a || !b) return false;
  const baseA = resolveBaseAgent(a, registeredBases);
  const baseB = resolveBaseAgent(b, registeredBases);
  if (!baseA || !baseB) return false;
  return baseA === baseB;
}

// -- private helpers --------------------------------------------------------

/**
 * Best-effort registry probe. `findAgent` already swallows DB errors and
 * returns null on miss; we additionally guard against registry lookup
 * raising synchronously (e.g. DB not yet initialised during boot or tests)
 * so a broken registry never makes the comparator throw — the caller just
 * sees "not registered" and the resolver peels further / returns the raw
 * id.
 */
function agentExists(id, registeredBases = null) {
  if (registeredBases instanceof Set) return registeredBases.has(id);
  try {
    return findAgent(id) != null;
  } catch (err) {
    swallow('auth.same_base_lookup_failed', err);
    return false;
  }
}
