/**
 * In-memory session-slot registry — mirrors the durable `sessions` row
 * state so dashboards and the reaper can list active sessions without
 * scanning the lease directory on every call. Synced with sdk/sessions
 * on open / close / periodic refresh.
 *
 * Flow:
 *   - `claimSlot({ baseAgent, pid })` wraps `sdk/sessions.claimSessionSlot`,
 *     persists the row, records in the in-memory map, and emits
 *     `session.opened`.
 *   - `releaseSlot({ sessionId, graceful })` wraps
 *     `sdk/sessions.releaseSessionSlot`, marks the row closed, and
 *     emits `session.closed`.
 *   - `refreshFromLeases(runDir, baseAgent)` forces a reconcile against
 *     the filesystem — used by the reaper on boot and when the in-memory
 *     map may have drifted (e.g. gateway restarted while agents remained
 *     alive).
 *   - `getActiveSlots(baseAgent)` returns the in-memory snapshot for
 *     a given base agent.
 *
 * The map is keyed by session id (the canonical `nova` / `nova-N`
 * string). Re-keying by base agent wasn't worth the extra index — the
 * number of live sessions per base stays tiny, and callers who want
 * "all slots for nova" can filter the full map in O(n) with no measurable
 * cost at realistic agent counts.
 */

import {
  claimSessionSlot,
  releaseSessionSlot,
  getActiveSlots as sdkGetActiveSlots,
  defaultRunDir,
} from '@cortex/sdk/sessions';
import { swallow } from '@cortex/sdk/errors';
import { getSessionStatements } from './statements.js';
import {
  emitSessionOpened,
  emitSessionClosed,
  emitSessionExpired,
} from './events.js';
import { formatSessionId, parseSessionId } from './identity.js';

// Module-scoped state. Tests clear via resetSlotRegistryForTests().
// sessionId -> { sessionId, baseAgent, slot, pid, openedAt, heldTasks }
const _registry = new Map();

function upsertEntry(entry) {
  _registry.set(entry.sessionId, entry);
}

function snapshot(entry) {
  // Defensive copy — callers must not mutate the registry row.
  return {
    sessionId: entry.sessionId,
    baseAgent: entry.baseAgent,
    slot: entry.slot,
    pid: entry.pid,
    openedAt: entry.openedAt,
    heldTasks: entry.heldTasks ? [...entry.heldTasks] : [],
  };
}

/**
 * Claim the next session slot for `baseAgent`. Writes the lease via
 * sdk/sessions, inserts a sessions row, and emits session.opened.
 *
 * @param {{ baseAgent: string, pid?: number, runDir?: string,
 *           taskId?: string | null, metadata?: Record<string, unknown> }} args
 */
export function claimSlot(args) {
  if (!args || typeof args.baseAgent !== 'string' || args.baseAgent.length === 0) {
    throw new Error('claimSlot: baseAgent must be a non-empty string');
  }
  const pid = Number.isInteger(args.pid) ? args.pid : process.pid;
  const runDir = args.runDir || defaultRunDir();
  const { sessionId, n } = claimSessionSlot(runDir, args.baseAgent, pid);
  const openedAt = Date.now();

  const stmts = getSessionStatements();
  const metadataJson = JSON.stringify(args.metadata || {});
  // sessions.agent_id FK-references agents(id); insert NULL when the
  // base agent isn't yet registered so the FK doesn't block the session
  // row. base_agent is stored alongside as a plain string (no FK), so
  // the lookup path "list sessions for nova" still works without the
  // agent row existing.
  const agentFkValue = stmts.getAgent.get(args.baseAgent) ? args.baseAgent : null;
  try {
    stmts.insertSession.run(
      sessionId,
      agentFkValue,
      args.taskId || null,
      'active',
      args.baseAgent,
      n,
      pid,
      openedAt,
      openedAt,
      '[]',
      metadataJson,
    );
  } catch (err) {
    // DB write failed but the lease is claimed on disk — don't roll the
    // lease back (it's the source of truth for PID liveness). Record
    // the error; the reaper's lease-based reconcile will pick up the
    // session on its next tick.
    swallow('sessions.slot_persist_failed', err);
  }

  const entry = {
    sessionId,
    baseAgent: args.baseAgent,
    slot: n,
    pid,
    openedAt,
    heldTasks: [],
  };
  upsertEntry(entry);

  try {
    emitSessionOpened({
      sessionId,
      baseAgent: args.baseAgent,
      slot: n,
      pid,
      openedAt,
    });
  } catch (err) {
    swallow('sessions.opened_emit_failed', err);
  }
  return snapshot(entry);
}

/**
 * Release a session slot. `graceful` distinguishes an orderly shutdown
 * (session-end hook) from a forced release (admin command):
 *   - graceful !== false  → emits session.closed only
 *   - graceful === false  → emits session.expired (reason=force_release)
 *     AND session.closed so downstream orphan logic fires immediately
 *     instead of waiting for the reaper's next sweep.
 *
 * @param {{ sessionId: string, pid?: number, runDir?: string,
 *           graceful?: boolean }} args
 */
export function releaseSlot(args) {
  if (!args || typeof args.sessionId !== 'string' || args.sessionId.length === 0) {
    throw new Error('releaseSlot: sessionId must be a non-empty string');
  }
  const parsed = parseSessionId(args.sessionId);
  if (!parsed) {
    return { released: false, reason: 'bad_session_id' };
  }
  const runDir = args.runDir || defaultRunDir();
  const pid = Number.isInteger(args.pid) ? args.pid : process.pid;
  const { baseAgent, slot } = parsed;

  const result = releaseSessionSlot(runDir, baseAgent, slot, pid);
  const closedAt = Date.now();

  // Persist the close regardless of filesystem outcome — a race where
  // the lease was already swept by the reaper (result.reason === 'not_found')
  // still needs the DB row marked closed.
  try {
    getSessionStatements().closeSession.run('closed', closedAt, args.sessionId);
  } catch (err) {
    swallow('sessions.slot_close_persist_failed', err);
  }
  _registry.delete(args.sessionId);

  const graceful = args.graceful !== false;

  // Force-release path — emit session.expired FIRST so the reaper's
  // subscriber can dispatch orphans before we emit closed. Order
  // matters because session.closed is the universal "session gone"
  // signal; if it arrived first, the expired emit would be redundant
  // from downstream's POV.
  if (!graceful) {
    try {
      emitSessionExpired({
        sessionId: args.sessionId,
        baseAgent,
        reason: 'force_release',
        detail: `slot=${slot}`,
        expiredAt: closedAt,
      });
    } catch (err) {
      swallow('sessions.force_release_emit_failed', err);
    }
  }

  if (result.released) {
    try {
      emitSessionClosed({
        sessionId: args.sessionId,
        baseAgent,
        closedAt,
      });
    } catch (err) {
      swallow('sessions.closed_emit_failed', err);
    }
  }

  return { ...result, sessionId: args.sessionId, graceful };
}

/**
 * Reconcile the in-memory map against the lease directory. Returns the
 * list of canonical session ids currently live on disk for the given
 * base agent. Called by the reaper on boot and whenever downstream
 * handlers suspect drift.
 *
 * @param {{ baseAgent: string, runDir?: string }} args
 */
export function refreshFromLeases(args) {
  if (!args || typeof args.baseAgent !== 'string' || args.baseAgent.length === 0) {
    throw new Error('refreshFromLeases: baseAgent must be a non-empty string');
  }
  const runDir = args.runDir || defaultRunDir();
  let slots = [];
  try {
    slots = sdkGetActiveSlots(runDir, args.baseAgent);
  } catch (err) {
    swallow('sessions.refresh_scan_failed', err);
    return [];
  }
  // Evict in-memory entries that are no longer on disk. Keep entries
  // whose lease exists — the authoritative fields (pid, openedAt) came
  // from the claim path so we trust the in-memory copy.
  const seen = new Set();
  for (const s of slots) {
    const sessionId = s.sessionId || formatSessionId(args.baseAgent, s.n);
    seen.add(sessionId);
    if (!_registry.has(sessionId) && s.pid > 0) {
      // Lease is live but we have no in-memory record — rebuild a
      // minimal entry so listActive() reflects reality.
      upsertEntry({
        sessionId,
        baseAgent: args.baseAgent,
        slot: s.n,
        pid: s.pid,
        openedAt: Date.now(),
        heldTasks: [],
      });
    }
  }
  for (const [sessionId, entry] of _registry) {
    if (entry.baseAgent !== args.baseAgent) continue;
    if (!seen.has(sessionId)) _registry.delete(sessionId);
  }
  return slots;
}

/**
 * All in-memory registry entries for a given base agent. Returns [] if
 * none are tracked. `baseAgent` must be the bare base id; pass null for
 * every session regardless of base.
 *
 * @param {string | null} [baseAgent]
 */
export function getActiveSlots(baseAgent = null) {
  const out = [];
  for (const entry of _registry.values()) {
    if (baseAgent != null && entry.baseAgent !== baseAgent) continue;
    out.push(snapshot(entry));
  }
  out.sort((a, b) => {
    if (a.baseAgent !== b.baseAgent) return a.baseAgent < b.baseAgent ? -1 : 1;
    return a.slot - b.slot;
  });
  return out;
}

/**
 * Record a held-task id on the session entry so the reaper has an
 * O(1) lookup during orphan dispatch. Also persists to the sessions
 * row so a gateway restart doesn't forget the holdings.
 *
 * @param {{ sessionId: string, taskId: string }} args
 */
export function addHeldTask(args) {
  if (!args || typeof args.sessionId !== 'string' || typeof args.taskId !== 'string') {
    return { ok: false, reason: 'bad_args' };
  }
  const entry = _registry.get(args.sessionId);
  if (!entry) return { ok: false, reason: 'not_tracked' };
  if (!entry.heldTasks) entry.heldTasks = [];
  if (!entry.heldTasks.includes(args.taskId)) {
    entry.heldTasks.push(args.taskId);
  }
  try {
    getSessionStatements().updateSessionHeldTasks.run(
      JSON.stringify(entry.heldTasks),
      args.sessionId,
    );
  } catch (err) {
    swallow('sessions.held_task_persist_failed', err);
  }
  return { ok: true, heldTasks: [...entry.heldTasks] };
}

/**
 * Remove a held-task id — called when a task is submitted or released.
 *
 * @param {{ sessionId: string, taskId: string }} args
 */
export function removeHeldTask(args) {
  if (!args || typeof args.sessionId !== 'string' || typeof args.taskId !== 'string') {
    return { ok: false, reason: 'bad_args' };
  }
  const entry = _registry.get(args.sessionId);
  if (!entry || !entry.heldTasks) return { ok: true, heldTasks: [] };
  entry.heldTasks = entry.heldTasks.filter((id) => id !== args.taskId);
  try {
    getSessionStatements().updateSessionHeldTasks.run(
      JSON.stringify(entry.heldTasks),
      args.sessionId,
    );
  } catch (err) {
    swallow('sessions.held_task_persist_failed', err);
  }
  return { ok: true, heldTasks: [...entry.heldTasks] };
}

export function resetSlotRegistryForTests() {
  _registry.clear();
}
