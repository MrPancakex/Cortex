/**
 * Thin wrappers that emit session.* and agent.* events. Consolidating
 * every emit site for the sessions plane in one file serves two purposes:
 *
 *   1. The events-schema-check lint (Rule 3.A) requires every file with
 *      an `emit('x.y', ...)` call to import from
 *      @cortex/core/schemas/events. Keeping the emits here means only
 *      this file carries the import — slot-registry/heartbeat/reaper
 *      stay clean.
 *
 *   2. Future instrumentation (tracing, sampling, back-pressure) attaches
 *      at a single point instead of being scattered across every handler.
 *
 * The task.orphaned emitter also lives here — the orphan-dispatcher
 * sits inside the sessions plane (it's the reaper's downstream action),
 * so keeping that emit alongside session.expired avoids a second
 * schema import in orphan-dispatcher.js.
 *
 * Emit semantics: every helper is synchronous. `emit()` throws if the
 * payload is rejected by its schema; callers that wrap in try/catch to
 * keep the main flow alive should swallow('sessions.emit_failed', err).
 */

import { emit } from '@cortex/sdk/events';
// The import below exists to anchor the events-schema-check lint; every
// subject emitted from this module is validated against the taxonomy at
// emit time via payloadSchemaFor inside sdk/events/validate.js.
import { EventEnvelopeSchema as _anchor } from '@cortex/core/schemas/events';

const SOURCE = 'gateway.sessions';

/**
 * @param {{ sessionId: string, baseAgent: string, slot: number,
 *           pid: number, openedAt?: number }} args
 */
export function emitSessionOpened(args) {
  emit('session.opened', {
    session_id: args.sessionId,
    base_agent: args.baseAgent,
    slot: args.slot,
    pid: args.pid,
    opened_at: args.openedAt ?? Date.now(),
  }, { source: SOURCE, session_id: args.sessionId });
}

/**
 * @param {{ sessionId: string, baseAgent: string, ts?: number }} args
 */
export function emitSessionHeartbeat(args) {
  emit('session.heartbeat', {
    session_id: args.sessionId,
    base_agent: args.baseAgent,
    ts: args.ts ?? Date.now(),
  }, { source: SOURCE, session_id: args.sessionId });
}

/**
 * Reason MUST be one of: pid_dead | heartbeat_timeout | lease_corrupt |
 * force_release. Emitting anything else throws (schema enforced).
 *
 * @param {{ sessionId: string, baseAgent: string,
 *           reason: 'pid_dead' | 'heartbeat_timeout' | 'lease_corrupt' | 'force_release',
 *           detail?: string, expiredAt?: number }} args
 */
export function emitSessionExpired(args) {
  const payload = {
    session_id: args.sessionId,
    base_agent: args.baseAgent,
    reason: args.reason,
    expired_at: args.expiredAt ?? Date.now(),
  };
  if (args.detail) payload.detail = args.detail;
  emit('session.expired', payload, { source: SOURCE, session_id: args.sessionId });
}

/**
 * @param {{ sessionId: string, baseAgent: string, closedAt?: number }} args
 */
export function emitSessionClosed(args) {
  emit('session.closed', {
    session_id: args.sessionId,
    base_agent: args.baseAgent,
    closed_at: args.closedAt ?? Date.now(),
  }, { source: SOURCE, session_id: args.sessionId });
}

/**
 * @param {{ agentId: string, platform?: string, registeredAt?: number }} args
 */
export function emitAgentRegistered(args) {
  const payload = {
    agent_id: args.agentId,
    registered_at: args.registeredAt ?? Date.now(),
  };
  if (args.platform) payload.platform = args.platform;
  emit('agent.registered', payload, { source: SOURCE });
}

/**
 * @param {{ agentId: string, fields: Record<string, unknown>, updatedAt?: number }} args
 */
export function emitAgentUpdated(args) {
  emit('agent.updated', {
    agent_id: args.agentId,
    fields: args.fields,
    updated_at: args.updatedAt ?? Date.now(),
  }, { source: SOURCE });
}

/**
 * @param {{ agentId: string, lastHeartbeatAt: number, detectedAt?: number }} args
 */
export function emitAgentStale(args) {
  emit('agent.stale', {
    agent_id: args.agentId,
    last_heartbeat_at: args.lastHeartbeatAt,
    detected_at: args.detectedAt ?? Date.now(),
  }, { source: SOURCE });
}

/**
 * task.orphaned emit — lives in the sessions plane because the orphan
 * dispatch is triggered by session lifecycle events (expired/closed).
 * The tasks plane (Phase 5) consumes this subject to perform the actual
 * task-row mutation; the sessions plane emits the signal only.
 *
 * @param {{ taskId: string, previousAgent: string | null,
 *           previousStatus: 'pending' | 'claimed' | 'in_progress' | 'submitted' | 'review',
 *           reason: 'agent_stale' | 'session_expired' | 'force_release' | 'cancel',
 *           orphanedAt?: number }} args
 */
export function emitTaskOrphaned(args) {
  const payload = {
    task_id: args.taskId,
    previous_agent: args.previousAgent,
    previous_status: args.previousStatus,
    reason: args.reason,
    orphaned_at: args.orphanedAt ?? Date.now(),
  };
  emit('task.orphaned', payload, { source: SOURCE, task_id: args.taskId });
}
