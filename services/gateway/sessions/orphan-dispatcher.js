/**
 * Orphan dispatcher — the downstream action the reaper takes when a
 * session expires or closes hard. Enumerates the tasks the session was
 * holding (via the `tasks.assigned_to = ?` query) and emits one
 * `task.orphaned` event per task. The tasks plane (Phase 5) owns the
 * actual status transition — this file only emits the signal.
 *
 * Reason mapping (session → task.orphaned.reason):
 *   pid_dead          → session_expired
 *   heartbeat_timeout → session_expired
 *   lease_corrupt     → session_expired   (the agent is effectively gone)
 *   force_release     → force_release     (operator-initiated)
 *   session_closed    → session_expired   (hard close without cleanup)
 *
 * The dispatcher NEVER writes to the tasks table — doing so would
 * cross plane boundaries (Rule 1). Phase 5 subscribes to `task.orphaned`
 * and handles the DB write there.
 */

import { swallow } from '@cortex/sdk/errors';
import { getSessionStatements } from './statements.js';
import { emitTaskOrphaned } from './events.js';
import { parseSessionId } from './identity.js';

/**
 * Map a session-termination reason into the task.orphaned reason enum.
 * Unknown reasons default to `session_expired` — safer than dropping
 * the orphan signal entirely.
 */
function mapReason(sessionReason) {
  if (sessionReason === 'force_release') return 'force_release';
  // pid_dead, heartbeat_timeout, lease_corrupt, session_closed, and
  // anything else all collapse to session_expired — the task was
  // assigned to a session that no longer exists.
  return 'session_expired';
}

/**
 * Look up and emit `task.orphaned` for every task the given session was
 * holding. Returns the list of task ids that were orphaned.
 *
 * @param {{ sessionId: string, agentId?: string,
 *           reason: string }} args
 * @returns {Array<string>}  task ids for which task.orphaned was emitted
 */
export function dispatchOrphan(args) {
  if (!args || typeof args.sessionId !== 'string' || args.sessionId.length === 0) {
    throw new Error('dispatchOrphan: sessionId must be a non-empty string');
  }

  const parsed = parseSessionId(args.sessionId);
  // previous_agent SHOULD be the base id (e.g. 'nova') so dashboards
  // showing "who owned this task" don't fragment across session slots.
  // Caller-supplied agentId wins when present; otherwise fall back to
  // the parsed base, and lastly to the raw session id.
  const previousAgent = args.agentId || parsed?.baseAgent || args.sessionId;
  const mapped = mapReason(args.reason);
  const orphanedAt = Date.now();

  let rows = [];
  try {
    rows = getSessionStatements().getHeldTasksBySession.all(args.sessionId);
  } catch (err) {
    swallow('sessions.orphan_query_failed', err);
    return [];
  }

  const orphaned = [];
  // The task.orphaned payload schema requires previous_status to be one
  // of: pending | claimed | in_progress | submitted | review. The held
  // tasks query filters on claimed/in_progress, so any row that slips
  // through with a different status (defensive case) gets clamped down
  // to 'claimed' — still forensically useful, never a schema rejection.
  const ALLOWED_PREV = new Set(['pending', 'claimed', 'in_progress', 'submitted', 'review']);
  for (const row of rows) {
    const prevStatus = ALLOWED_PREV.has(row.status) ? row.status : 'claimed';
    try {
      emitTaskOrphaned({
        taskId: row.id,
        previousAgent,
        previousStatus: prevStatus,
        reason: mapped,
        orphanedAt,
      });
      orphaned.push(row.id);
    } catch (err) {
      swallow('sessions.orphan_emit_failed', err);
    }
  }
  return orphaned;
}
