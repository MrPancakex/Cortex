/**
 * Reject-counter guard. Caps how many times a single task may cycle
 * through rejection before the gate refuses further rejects (the task
 * goes to manual escalation instead).
 *
 * Previously the MAX_REJECTIONS cap was an inline magic number in the
 * reject handler (legacy services/gateway/routes/cortex-tasks.js
 * §1228-1310). Extracting it here:
 *   - Makes the cap a declarative constant in @cortex/core/constants,
 *     tunable for tests without touching handler code.
 *   - Gives routes.js a uniform middleware form to attach on
 *     reject-effecting endpoints.
 *   - Keeps the guard testable without spinning up a full HTTP stack.
 *
 * The counter is read from tasks.rejection_count — the single writer is
 * the tasks plane's incrementRejectionCount statement, so there's no
 * double-bookkeeping.
 */

import { swallow } from '@cortex/sdk/errors';
import { MAX_REJECTIONS } from '@cortex/core/constants';
import { getGateStatements } from './statements.js';

/**
 * Read the current rejection count for a task. Returns 0 when the task
 * row is missing (callers should already have resolved the task via
 * the tasks plane before calling this) or when the column is NULL.
 */
export function getRejectionCount(taskId) {
  try {
    if (!taskId) return 0;
    const stmts = getGateStatements();
    const row = stmts.getTaskRejectionCount.get(taskId);
    return row?.count || 0;
  } catch (err) {
    swallow('gate.max_rejections_read_failed', err);
    return 0;
  }
}

/**
 * Would the NEXT reject push this task past the cap? Used by the
 * reject handler to decide between "reject normally" and "escalate".
 *
 * @param {string} taskId
 * @param {number} [cap]  override the default — tests and the admin
 *   surface pass a narrower cap to exercise the escalation path.
 */
export function wouldExceedCap(taskId, cap = MAX_REJECTIONS) {
  const current = getRejectionCount(taskId);
  return current + 1 > cap;
}

/**
 * Summary check for the admin / debug surface.
 *
 * @returns {{ count: number, cap: number, would_exceed: boolean }}
 */
export function summariseTaskRejections(taskId, cap = MAX_REJECTIONS) {
  const count = getRejectionCount(taskId);
  return {
    count,
    cap,
    would_exceed: count + 1 > cap,
  };
}

/**
 * Middleware form for the gateway's adapter pattern. Returns a handler
 * shaped `(ctx) => { status, body } | null`. Rejects with HTTP 409 when
 * the cap is hit; pass-through (null) otherwise.
 *
 * The shape mirrors stubDetectorMiddleware so the route mount pattern
 * is uniform.
 */
export function maxRejectionsMiddleware(options = {}) {
  const cap = Number.isInteger(options.cap) && options.cap > 0
    ? options.cap
    : MAX_REJECTIONS;
  return (ctx) => {
    const taskId = options.taskIdFrom
      ? options.taskIdFrom(ctx)
      : ctx?.params?.taskId || ctx?.body?.task_id;
    if (!taskId) return null;
    try {
      if (wouldExceedCap(taskId, cap)) {
        const current = getRejectionCount(taskId);
        return {
          status: 409,
          body: {
            error: 'max_rejections',
            reason_code: 'max_rejections_exceeded',
            reason: `task ${taskId} already rejected ${current} times (cap ${cap})`,
            escalate: true,
          },
        };
      }
      ctx.gate = {
        ...(ctx.gate || {}),
        rejectionCount: getRejectionCount(taskId),
        rejectionCap: cap,
      };
      return null;
    } catch (err) {
      // Fail open — the handler's own bookkeeping still runs. Worst
      // case the cap is missed by one; escalation surfaces it on the
      // next cycle.
      swallow('gate.max_rejections_middleware_failed', err);
      return null;
    }
  };
}
