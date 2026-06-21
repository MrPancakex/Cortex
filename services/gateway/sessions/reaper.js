/**
 * Session reaper — Phase 6 reshape from polling GC into an event
 * subscriber. Responsibilities:
 *
 *   1. Subscribe to `session.expired` and `session.closed`. On receipt,
 *      dispatch orphan events for any tasks the session was holding.
 *
 *   2. Run a timed sweep (default 30s, matching POISON_SWEEP_MS) that
 *      only *detects* stale heartbeats + dead leases and *emits*
 *      `session.expired`. The reclaim itself is subscriber-driven —
 *      same handler fires for events we emit and events emitted by
 *      other planes (session-end hook).
 *
 * Why not keep the polling reclaim?
 *   A heartbeat-timeout expiry was previously a 60-second blind spot
 *   because the reaper both detected AND reclaimed on its interval.
 *   Decoupling means a session that closes via the session-end hook
 *   reclaims IMMEDIATELY; the interval only exists as a fallback for
 *   sessions that don't cleanly call releaseSlot.
 *
 * Event-first design also lets future planes (cost accounting, dashboard
 * live counters) react to session lifecycle without each one polling
 * the same DB.
 */

import {
  releaseSessionSlotIfDead,
  defaultRunDir,
} from '@cortex/sdk/sessions';
import { subscribe } from '@cortex/sdk/events';
import { swallow } from '@cortex/sdk/errors';
import {
  POISON_SWEEP_MS,
  HEARTBEAT_GRACE_MS,
} from '@cortex/core/constants';
import { getSessionStatements } from './statements.js';
import { dispatchOrphan } from './orphan-dispatcher.js';
import {
  emitSessionExpired,
  emitAgentStale,
} from './events.js';
import { parseSessionId } from './identity.js';

/**
 * Start the reaper. Returns `{ stop }` — caller invokes stop() during
 * shutdown to clear the sweep interval AND unregister subscriptions.
 *
 * @param {{ intervalMs?: number, staleHeartbeatMs?: number,
 *           runDir?: string, logger?: (info: unknown) => void }} opts
 */
export function startReaper(opts = {}) {
  const intervalMs = Number.isInteger(opts.intervalMs) && opts.intervalMs > 0
    ? opts.intervalMs
    : POISON_SWEEP_MS;
  const staleHeartbeatMs = Number.isInteger(opts.staleHeartbeatMs) && opts.staleHeartbeatMs > 0
    ? opts.staleHeartbeatMs
    : HEARTBEAT_GRACE_MS;
  const runDir = opts.runDir || defaultRunDir();
  const logger = typeof opts.logger === 'function' ? opts.logger : null;

  const unsubClosed = subscribe('session.closed', async (event) => {
    try {
      const payload = event?.payload || {};
      dispatchOrphan({
        sessionId: payload.session_id,
        agentId: payload.base_agent,
        reason: 'session_closed',
      });
      if (logger) logger({ event: 'session.closed.handled', sessionId: payload.session_id });
    } catch (err) {
      swallow('sessions.reaper_closed_handler_failed', err);
    }
  });

  const unsubExpired = subscribe('session.expired', async (event) => {
    try {
      const payload = event?.payload || {};
      dispatchOrphan({
        sessionId: payload.session_id,
        agentId: payload.base_agent,
        reason: payload.reason || 'session_expired',
      });
      if (logger) logger({ event: 'session.expired.handled', sessionId: payload.session_id });
    } catch (err) {
      swallow('sessions.reaper_expired_handler_failed', err);
    }
  });

  const tick = () => {
    try {
      const summary = runReaperOnce({ runDir, staleHeartbeatMs });
      if (logger && (summary.staleSessions > 0 || summary.staleAgents > 0 || summary.sweptLeases > 0)) {
        logger(summary);
      }
    } catch (err) {
      // Never let reaper errors kill the gateway.
      swallow('sessions.reaper_tick_failed', err);
      if (logger) logger({ error: err?.message });
    }
  };
  // Fire once immediately so the first sweep doesn't wait an entire interval.
  tick();
  const intervalId = setInterval(tick, intervalMs);
  if (typeof intervalId.unref === 'function') intervalId.unref();

  return {
    stop() {
      clearInterval(intervalId);
      unsubClosed();
      unsubExpired();
    },
  };
}

/**
 * Single reaper pass — pure detection, no reclaim. Emits
 * `session.expired` for every stale-heartbeat row and
 * `agent.stale` for every stale-heartbeat agent, plus opportunistically
 * sweeps dead leases from the filesystem for each known session.
 *
 * Returns `{ staleSessions, staleAgents, sweptLeases }` for observability.
 *
 * @param {{ runDir?: string, staleHeartbeatMs?: number, now?: number }} opts
 */
export function runReaperOnce(opts = {}) {
  const runDir = opts.runDir || defaultRunDir();
  const staleHeartbeatMs = Number.isInteger(opts.staleHeartbeatMs) && opts.staleHeartbeatMs > 0
    ? opts.staleHeartbeatMs
    : HEARTBEAT_GRACE_MS;
  const now = Number.isInteger(opts.now) ? opts.now : Date.now();
  const cutoff = now - staleHeartbeatMs;

  const stmts = getSessionStatements();

  let staleSessions = 0;
  let staleAgents = 0;
  let sweptLeases = 0;

  // 1. Stale-heartbeat sessions → emit session.expired and sweep leases.
  let staleRows = [];
  try {
    staleRows = stmts.listStaleSessions.all(cutoff);
  } catch (err) {
    swallow('sessions.reaper_list_stale_failed', err);
  }
  for (const row of staleRows) {
    const sessionId = row.id;
    const parsed = parseSessionId(sessionId);
    const baseAgent = row.base_agent || parsed?.baseAgent || sessionId;
    const slot = Number.isInteger(row.slot) ? row.slot : parsed?.slot;
    try {
      emitSessionExpired({
        sessionId,
        baseAgent,
        reason: 'heartbeat_timeout',
        detail: `last_heartbeat_at=${row.last_heartbeat_at}`,
        expiredAt: now,
      });
      staleSessions += 1;
    } catch (err) {
      swallow('sessions.reaper_expired_emit_failed', err);
    }
    // Mark the DB row closed so a subsequent pass doesn't re-emit. Use
    // the 'expired' status for forensic clarity.
    try {
      stmts.closeSession.run('expired', now, sessionId);
    } catch (err) {
      swallow('sessions.reaper_close_persist_failed', err);
    }
    // Opportunistic lease sweep — only acts if the recorded pid is
    // verifiably dead. Returns { released: false, reason: 'pid_alive' }
    // when the agent is still running, which is the correct no-op.
    if (typeof slot === 'number') {
      try {
        const result = releaseSessionSlotIfDead(runDir, baseAgent, slot);
        if (result.released) sweptLeases += 1;
      } catch (err) {
        swallow('sessions.reaper_lease_sweep_failed', err);
      }
    }
  }

  // 2. Stale-heartbeat agents → emit agent.stale.
  let staleAgentRows = [];
  try {
    staleAgentRows = stmts.getStaleAgents.all(cutoff);
  } catch (err) {
    swallow('sessions.reaper_list_stale_agents_failed', err);
  }
  for (const row of staleAgentRows) {
    try {
      emitAgentStale({
        agentId: row.id,
        lastHeartbeatAt: row.last_heartbeat_at,
        detectedAt: now,
      });
      staleAgents += 1;
    } catch (err) {
      swallow('sessions.reaper_stale_emit_failed', err);
    }
    try {
      stmts.markAgentStale.run(row.id);
    } catch (err) {
      swallow('sessions.reaper_mark_stale_failed', err);
    }
  }

  return { staleSessions, staleAgents, sweptLeases };
}
