/**
 * Heartbeat handling — agents bump their last-seen timestamp via
 * `POST /v1/api/heartbeat` (routes.js) which calls `upsertHeartbeat`
 * here. The write path persists to BOTH the `agents` row AND the
 * matching `sessions` row (so the reaper's stale-session sweep sees
 * live long-running sessions), and emits `session.heartbeat` so
 * subscribers (dashboards, reaper) can react without polling.
 *
 * Split into a dedicated file because every heartbeat call is a
 * write-plus-emit pair and consolidating the emit here lets the
 * Rule 3.A lint pass on one import (from events.js).
 */

import { swallow } from '@cortex/sdk/errors';
import { getSessionStatements } from './statements.js';
import { emitSessionHeartbeat } from './events.js';
import { parseSessionId } from './identity.js';

/**
 * Record a heartbeat for an agent (or session slot) and emit
 * session.heartbeat. Idempotent — repeated calls just bump the
 * last_heartbeat_at column on both the agents row AND the matching
 * sessions row.
 *
 * Why update both:
 *   - agents.last_heartbeat_at drives the stale-agent sweep
 *     (reaper.getStaleAgents + agent.stale emission).
 *   - sessions.last_heartbeat_at drives the stale-session sweep
 *     (reaper.listStaleSessions + session.expired emission). Before
 *     this dual-write, slot-registry only seeded the sessions value at
 *     claimSlot() time and it never advanced — so a live long-running
 *     session would age out and emit session.expired even while the
 *     agent was heartbeating normally.
 *
 * The sessions UPDATE is a no-op for agent ids that don't have a
 * matching session row (e.g. a heartbeat from an unregistered agent or
 * from a base id when only slot-N rows exist). Zero changes there is
 * the correct behavior — we don't create a session row from a
 * heartbeat.
 *
 * @param {{ agentId: string, currentTask?: string | null, platform?: string | null,
 *           ts?: number }} args
 * @returns {{ ok: boolean, updated: number, sessionUpdated: number }}
 */
export function upsertHeartbeat(args) {
  if (!args || typeof args.agentId !== 'string' || args.agentId.length === 0) {
    throw new Error('upsertHeartbeat: agentId must be a non-empty string');
  }
  const ts = Number.isInteger(args.ts) ? args.ts : Date.now();
  const stmts = getSessionStatements();
  const info = stmts.upsertAgentHeartbeat.run(
    ts,
    args.currentTask ?? null,
    args.platform ?? null,
    args.agentId,
  );
  const updated = Number(info.changes);

  // Bump the sessions row too so the reaper's stale-session sweep
  // (listStaleSessions, which reads sessions.last_heartbeat_at) sees
  // live heartbeats and doesn't age the session out. We don't guard
  // the call — UPDATE against a missing id is a cheap zero-row write.
  let sessionUpdated = 0;
  try {
    const sessionInfo = stmts.updateSessionHeartbeat.run(ts, args.agentId);
    sessionUpdated = Number(sessionInfo.changes);
  } catch (err) {
    // Swallow rather than throw — a DB error on the sessions update
    // must not prevent the agent heartbeat emit, which is the primary
    // liveness signal for dashboards and the stale-agent path.
    swallow('sessions.heartbeat_session_persist_failed', err);
  }

  // Emit regardless of updated-count: a heartbeat from an unregistered
  // agent still tells subscribers the agent is alive. (Legacy code
  // inserted a synthetic row; rebuild keeps registration as a distinct
  // step — here we only emit the lifecycle event.)
  const parsed = parseSessionId(args.agentId);
  try {
    emitSessionHeartbeat({
      sessionId: args.agentId,
      baseAgent: parsed?.baseAgent || args.agentId,
      ts,
    });
  } catch (err) {
    swallow('sessions.heartbeat_emit_failed', err);
  }
  return { ok: true, updated, sessionUpdated };
}

/**
 * Read the latest heartbeat row for a specific session/agent id.
 * Returns null if no row exists.
 *
 * @param {string} agentId
 */
export function getHeartbeat(agentId) {
  if (typeof agentId !== 'string' || agentId.length === 0) return null;
  const row = getSessionStatements().getAgentHeartbeat.get(agentId);
  return row || null;
}

/**
 * Read every heartbeat row for a base agent — exact match on the
 * base id plus any `<base>-N` slot. Returns [] when nothing matches.
 * Mirrors the legacy getSessionHeartbeats shape.
 *
 * @param {string} baseAgent
 */
export function getSessionHeartbeats(baseAgent) {
  if (typeof baseAgent !== 'string' || baseAgent.length === 0) return [];
  return getSessionStatements().getSessionHeartbeats.all(baseAgent);
}
