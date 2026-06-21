import { z } from 'zod';
import { gatewayJson, persistTaskState } from './_shared.js';
import { getAgentId } from '@cortex/sdk/auth';
import { completeTaskWorker, lookupRunningTaskWorker } from '@cortex/sdk/sessions';
import { swallow } from '@cortex/sdk/errors';

/**
 * task_submit_for_review — composite lifecycle tool.
 *
 * ORCHESTRATION ONLY. Calls two existing tools' underlying HTTP routes in
 * sequence, forwarding args verbatim, aborting on the first failure.
 *
 *   1. POST /tasks/:id/submit          (submit_result)
 *   2. POST /tasks/:id/request-review  (request_verification)
 *
 * Validate only the inputs owned by the next step before executing that step.
 * submit_result-owned inputs are validated before step 1; reviewer is
 * validated immediately before request_verification, after submit_result side
 * effects have occurred. Route-owned semantic validation, authz, strict-mode
 * submit gate (journal_incomplete), and event writes stay in the underlying
 * routes.
 *
 * If submit_result succeeds but request_verification fails (e.g. invalid
 * reviewer), the task remains in status=submitted — this is the same
 * state the individual sequence would leave (manual parity). The response
 * names the failed step so the caller can recover (e.g. retry
 * request_verification directly).
 *
 * ERROR CODES: the envelope's `error` carries the same code-string the
 * individual MCP tools surface (gatewayJson parity). Richer error fields
 * such as `missing` or `present` are dropped identically on both paths,
 * by design — the route error is surfaced through gatewayJson which only
 * forwards body.error. (5)
 *
 * MERGE-SEAM NOTE (TE-5): this composite embeds raw route responses.
 * TE-5's tool-layer response slimming does NOT apply inside composites —
 * coordinate at merge to avoid a breaking shape change. (7)
 *
 * RESPONSE shape (all cases):
 *   { completed_steps: string[], failed_step?: string, error?: any }
 *
 * On success:
 *   { completed_steps: ['submit_result', 'request_verification'],
 *     status, file_sync, local_state }
 *   (status/file_sync/local_state come from the final persistTaskState call)
 */

export const TaskSubmitForReviewInputSchema = z.object({
  task_id: z.string().min(1),
  // summary: mirrors SubmitResultInputSchema (submit_result.js) — min(1) only, no max;
  // the direct tool defers over-length rejection to the route's 400.
  summary: z.string().min(1),
  files_changed: z.array(z.string()).optional(),
});

const TaskSubmitForReviewRequestInputSchema = z.object({
  // reviewer mirrors RequestVerificationSchema min(1), but is checked at the
  // request_verification step to preserve manual sequence side effects.
  reviewer: z.string().min(1),
});

export const definition = {
  name: 'task_submit_for_review',
  protocolVersion: '1.0',
  description: [
    'Composite: submit_result + request_verification in one call.',
    'Equivalent to calling submit_result → request_verification individually.',
    'Strict-mode submit gate (journal minimum) fires inside this composite exactly as on direct submit_result.',
    'If submit succeeds but request_verification fails (invalid reviewer, etc.), task stays submitted — response names the failed step.',
    'Aborts on first failure; state after a mid-chain failure is EXACTLY what the individual sequence leaves.',
    'Response: { completed_steps, failed_step?, error? }.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      task_id:       { type: 'string', description: 'ID of the task to submit for review.' },
      summary:       { type: 'string', description: 'Completion summary (forwarded to submit_result).' },
      files_changed: { type: 'array', items: { type: 'string' }, description: 'Files changed (forwarded to submit_result).' },
      reviewer:      { type: 'string', description: 'Reviewer agent ID (forwarded to request_verification).' },
    },
    required: ['task_id', 'summary'],
  },
  schema: TaskSubmitForReviewInputSchema,
  capability: 'task.composite',
};

export async function handler(args, gateway) {
  // Validate only submit_result-owned inputs up front. reviewer belongs to
  // request_verification and is validated after submit_result succeeds.
  const parsed = TaskSubmitForReviewInputSchema.safeParse({
    task_id: args?.task_id,
    summary: args?.summary,
    files_changed: args?.files_changed,
  });
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }

  const taskId = parsed.data.task_id;

  const completed_steps = [];

  // ── Step 1: submit_result ─────────────────────────────────────────────────
  let submitResponse;
  try {
    submitResponse = await gatewayJson(
      gateway,
      `/v1/api/tasks/${encodeURIComponent(taskId)}/submit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          summary: parsed.data.summary,
          files_changed: parsed.data.files_changed ?? [],
        }),
      },
    );
    // Close out the matching subagent_events row stamped by claim_task.
    // Best-effort: a missing row is swallowed (same pattern as submit_result.js).
    if (gateway.db) {
      try {
        const parentAgent = getAgentId(gateway);
        if (parentAgent) {
          const eventId = lookupRunningTaskWorker({
            db: gateway.db,
            taskId,
            parentAgent,
          });
          if (eventId) {
            completeTaskWorker({
              db: gateway.db,
              eventId,
              parentAgent,
              summary: parsed.data.summary,
            });
          }
        }
      } catch (innerErr) {
        swallow('mcp.task_submit_for_review_complete_subagent_failed', innerErr);
      }
    }
  } catch (err) {
    return {
      completed_steps,
      failed_step: 'submit_result',
      error: err.message,
    };
  }
  completed_steps.push('submit_result');

  // submit_result succeeded — sync the current-task file exactly as the
  // individual submit_result handler does. This must happen before step 2 so
  // that a later request_verification failure leaves the file in the same
  // state the manual sequence would (synced after submit).
  await persistTaskState(gateway, submitResponse, 'sync', taskId);

  // ── Step 2: request_verification ─────────────────────────────────────────
  const reviewParsed = TaskSubmitForReviewRequestInputSchema.safeParse({
    reviewer: args?.reviewer,
  });
  if (!reviewParsed.success) {
    return {
      completed_steps,
      failed_step: 'request_verification',
      error: 'invalid_arguments',
      issues: reviewParsed.error.issues,
    };
  }

  let reviewResponse;
  try {
    reviewResponse = await gatewayJson(
      gateway,
      `/v1/api/tasks/${encodeURIComponent(taskId)}/request-review`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewer: reviewParsed.data.reviewer }),
      },
    );
  } catch (err) {
    // submit_result already succeeded — task is now submitted and the
    // current-task file was synced above. A failed request_verification in
    // the individual sequence does NOT clear the file — leave it as-is.
    return {
      completed_steps,
      failed_step: 'request_verification',
      error: err.message,
    };
  }
  completed_steps.push('request_verification');

  // All steps succeeded — persist final state and return.
  const statePayload = await persistTaskState(gateway, reviewResponse, 'sync', taskId);
  return { ...statePayload, completed_steps };
}
