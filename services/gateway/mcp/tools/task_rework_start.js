import { z } from 'zod';
import { gatewayJson, persistTaskState } from './_shared.js';
import { agentContext, getAgentId } from '@cortex/sdk/auth';
import { registerTaskWorker } from '@cortex/sdk/sessions';
import { swallow } from '@cortex/sdk/errors';

/**
 * task_rework_start — composite lifecycle tool.
 *
 * ORCHESTRATION ONLY. Calls three existing tools' underlying HTTP routes in
 * sequence, forwarding args verbatim, aborting on the first failure.
 *
 *   1. POST /tasks/:id/reopen     (task_reopen)
 *   2. POST /tasks/:id/claim      (claim_task)
 *   3. POST /tasks/:id/progress   (report_progress, stage=planning)
 *
 * Validate only the inputs owned by the next step before executing that step.
 * task_reopen-owned inputs are validated before step 1; report_progress-owned
 * plan_summary is validated immediately before step 3, after task_reopen and
 * claim_task side effects have occurred. Route-owned semantic validation,
 * authz, and event writes stay in the underlying routes.
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
 *   { completed_steps: ['task_reopen', 'claim_task', 'report_progress'],
 *     status, file_sync, local_state }
 *   (status/file_sync/local_state come from the final persistTaskState call)
 *
 * On mid-chain failure the task state is EXACTLY what the equivalent
 * individual-call sequence would leave — there is no hidden rollback or
 * retry. After task_reopen succeeds, persistTaskState('clear') is run
 * IMMEDIATELY (mirroring task_reopen.js:29), before claim_task is
 * attempted. If step 2 (claim_task) fails — including any setup throw from
 * agentContext() — the file is already cleared (matching the individual
 * sequence). If step 3 (report_progress) fails AFTER claim_task succeeded,
 * the file is left synced to the claimed task — matching the individual
 * sequence where claim_task sets the file and a later failed report_progress
 * does not clear it.
 */

export const TaskReworkStartInputSchema = z.object({
  task_id: z.string().min(1),
  // reason: mirrors TaskReopenInputSchema (task_reopen.js) — min(1) only, no max;
  // the direct tool defers over-length rejection to the route's 400.
  reason: z.string().min(1),
});

const TaskReworkStartProgressInputSchema = z.object({
  // plan_summary mirrors ProgressReportSchema.summary min/max, but is checked
  // at the report_progress step to preserve manual sequence side effects.
  plan_summary: z.string().min(1).max(4000),
});

export const definition = {
  name: 'task_rework_start',
  protocolVersion: '1.0',
  description: [
    'Composite: reopen + claim + report_progress(planning) in one call.',
    'Equivalent to calling task_reopen → claim_task → report_progress(planning, plan_summary) individually.',
    'Aborts on first failure; state after a mid-chain failure is EXACTLY what the individual sequence leaves.',
    'Response: { completed_steps, failed_step?, error? }.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      task_id:      { type: 'string', description: 'ID of the task to rework.' },
      reason:       { type: 'string', description: 'Why the task is being reopened (forwarded to task_reopen).' },
      plan_summary: { type: 'string', description: 'Planning progress summary (forwarded to report_progress).' },
    },
    required: ['task_id', 'reason'],
  },
  schema: TaskReworkStartInputSchema,
  capability: 'task.composite',
};

export async function handler(args, gateway) {
  // Validate only task_reopen-owned inputs up front. plan_summary belongs to
  // report_progress and is validated after task_reopen + claim_task succeed.
  const parsed = TaskReworkStartInputSchema.safeParse({
    task_id: args?.task_id,
    reason: args?.reason,
  });
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  const taskId = parsed.data.task_id;

  const completed_steps = [];

  // ── Step 1: task_reopen ───────────────────────────────────────────────────
  let reopenResponse;
  try {
    reopenResponse = await gatewayJson(
      gateway,
      `/v1/api/tasks/${encodeURIComponent(taskId)}/reopen`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: parsed.data.reason }),
      },
    );
  } catch (err) {
    return {
      completed_steps,
      failed_step: 'task_reopen',
      error: err.message,
    };
  }
  completed_steps.push('task_reopen');

  // Mirror task_reopen.js:29 — clear immediately after reopen succeeds, BEFORE
  // attempting claim. This ensures that any claim-step failure (including an
  // agentContext() setup throw) sees the file already cleared, matching the
  // individual handler order: reopen→clear, then claim→sync-on-success.
  await persistTaskState(gateway, {}, 'clear', taskId);

  // ── Step 2: claim_task ────────────────────────────────────────────────────
  // agentContext() is inside the try so any throw (missing agentId) is caught
  // by the composite envelope and returns failed_step=claim_task rather than
  // escaping as an unhandled exception.
  let claimResponse;
  try {
    const { platform } = agentContext(gateway);
    claimResponse = await gatewayJson(
      gateway,
      `/v1/api/tasks/${encodeURIComponent(taskId)}/claim`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform }),
      },
    );
    // Stamp a subagent_events 'task-worker' row so the dashboard can render
    // "agent is working on task X right now". Best-effort: a missing db handle
    // is swallowed rather than failing the claim (same pattern as claim_task.js).
    if (claimResponse.title && gateway.db) {
      try {
        const eventId = registerTaskWorker({
          db: gateway.db,
          parentAgent: getAgentId(gateway),
          taskId,
          taskTitle: claimResponse.title,
        });
        if (eventId) claimResponse._subagent_event_id = eventId;
      } catch (innerErr) {
        swallow('mcp.task_rework_start_register_subagent_failed', innerErr);
      }
    }
  } catch (err) {
    // Reopen + pre-reopen-clear already done above. Return the composite
    // envelope with failed_step — no second clear needed (already done).
    return {
      completed_steps,
      failed_step: 'claim_task',
      error: err.message,
    };
  }
  completed_steps.push('claim_task');

  // claim_task succeeded — sync the current-task file exactly as the
  // individual claim_task handler does. This must happen before step 3 so
  // that a later report_progress failure leaves the file in the same state
  // the manual sequence would (synced to the claimed task).
  await persistTaskState(gateway, claimResponse, 'sync', taskId);

  // ── Step 3: report_progress (planning) ───────────────────────────────────
  const progressParsed = TaskReworkStartProgressInputSchema.safeParse({
    plan_summary: args?.plan_summary,
  });
  if (!progressParsed.success) {
    return {
      completed_steps,
      failed_step: 'report_progress',
      error: 'invalid_arguments',
      issues: progressParsed.error.issues,
    };
  }

  let progressResponse;
  try {
    progressResponse = await gatewayJson(
      gateway,
      `/v1/api/tasks/${encodeURIComponent(taskId)}/progress`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          status: 'planning',
          summary: progressParsed.data.plan_summary,
          files_changed: [],
        }),
      },
    );
  } catch (err) {
    // Reopen + claim already succeeded. The current-task file was synced
    // after claim above. A failed report_progress in the individual sequence
    // does NOT clear the file — the file stays synced to the claimed task.
    // Do NOT call persistTaskState('clear') here.
    return {
      completed_steps,
      failed_step: 'report_progress',
      error: err.message,
    };
  }
  completed_steps.push('report_progress');

  // All steps succeeded — persist final state and return.
  const statePayload = await persistTaskState(gateway, progressResponse, 'sync', taskId);
  return { ...statePayload, completed_steps };
}
