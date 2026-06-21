/**
 * Orphan subscriber — closes the loop between the sessions plane's
 * orphan-dispatcher (which emits task.orphaned but does not write the
 * tasks table) and the tasks plane's orphanTask (which writes the
 * status flip).
 *
 * Without this subscriber, dead sessions emit task.orphaned into the
 * void: the row stays in `claimed`/`in_progress` forever and
 * claimOrphan is unreachable because nothing ever transitions the
 * status to `orphaned`. That class of leak compounds with every
 * session death, so wiring this is treated as cutover-blocking
 * (`rebuild-review-2026-05-08/02-plane-flow.md` F1 / runbook B1).
 *
 * The subscriber passes `skipEmit: true` to orphanTask so the canonical
 * task.orphaned consumer count stays at 1-per-session-death (the
 * dispatcher's emit). Without the flag, every dispatched orphan would
 * produce two task.orphaned events (M5).
 */

import { subscribe } from '@cortex/sdk/events';
import { swallow } from '@cortex/sdk/errors';
import { orphanTask } from './orphan.js';

/**
 * Wire the subscription. Returns `{stop}` so the caller can tear it
 * down on shutdown (mirrors the startReaper / startBridgeSocketFanout
 * shapes).
 */
export function startTaskOrphanSubscriber() {
  const unsubscribe = subscribe('task.orphaned', (event) => {
    const payload = event?.payload && typeof event.payload === 'object'
      ? event.payload
      : event;
    const taskId = payload?.task_id ?? event?.task_id;
    if (!event || !taskId) return;
    // The dispatcher's event payload is the public TaskOrphanedEventSchema
    // shape: task_id, previous_agent, previous_status, reason. orphanTask
    // accepts taskId + reason + previousOwner; map the names.
    try {
      const result = orphanTask({
        taskId,
        reason: payload.reason,
        previousOwner: payload.previous_agent ?? null,
        skipEmit: true,
      });
      // 200 = flipped; 409 = race / wrong status; 404 = task gone.
      // None of these are bugs in the subscriber — the emit was best-effort
      // and the DB is authoritative. Anything else is a real failure
      // worth surfacing as telemetry.
      if (result && result.status >= 500) {
        swallow('tasks.orphan_subscriber_db_error', new Error(
          `orphanTask returned ${result.status}: ${JSON.stringify(result.body)}`,
        ));
      }
    } catch (err) {
      // orphanTask throws only on programming errors; the route paths
      // catch internally and return {status, body}. Any throw here is
      // the kind of thing a production handler should observe.
      swallow('tasks.orphan_subscriber_unhandled', err);
    }
  });

  return {
    stop() {
      try {
        unsubscribe();
      } catch (err) {
        swallow('tasks.orphan_subscriber_stop_failed', err);
      }
    },
  };
}
