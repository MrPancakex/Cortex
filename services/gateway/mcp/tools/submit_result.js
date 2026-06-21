import { z } from 'zod';
import { gatewayJson, persistTaskState, slimMutationResponse } from './_shared.js';
import { getAgentId } from '@cortex/sdk/auth';
import { completeTaskWorker, lookupRunningTaskWorker } from '@cortex/sdk/sessions';
import { swallow } from '@cortex/sdk/errors';

export const SubmitResultInputSchema = z.object({
  task_id: z.string().min(1),
  summary: z.string().min(1),
  files_changed: z.array(z.string()).optional(),
});

export const definition = {
  name: 'submit_result',
  protocolVersion: '1.0',
  description: 'Submit completed work for a task.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string' },
      summary: { type: 'string' },
      files_changed: { type: 'array', items: { type: 'string' } },
    },
    required: ['task_id', 'summary'],
  },
  schema: SubmitResultInputSchema,
  capability: 'task.submit',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  const response = await gatewayJson(gateway, `/v1/api/tasks/${encodeURIComponent(args.task_id)}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      summary: args.summary,
      files_changed: args.files_changed || [],
    }),
  });
  // Close out the matching subagent_events row stamped by claim_task.
  // Look up by (task_id, parent_agent) — completion path is parent-scoped
  // both ways: lookupRunningTaskWorker filters on parent_agent, and
  // completeTaskWorker pins parent_agent in its UPDATE WHERE clause so
  // a stolen event_id from another agent's claim can't close this one.
  // Best-effort: a missing row (claim happened pre-migration, or fresh
  // DB) is swallowed — the submit itself is already authoritative.
  if (gateway.db) {
    try {
      const parentAgent = getAgentId(gateway);
      if (parentAgent) {
        const eventId = lookupRunningTaskWorker({
          db: gateway.db,
          taskId: args.task_id,
          parentAgent,
        });
        if (eventId) {
          completeTaskWorker({
            db: gateway.db,
            eventId,
            parentAgent,
            summary: args.summary,
          });
        }
      }
    } catch (err) {
      swallow('mcp.submit_result_complete_subagent_failed', err);
    }
  }
  const persisted = await persistTaskState(gateway, response, 'sync', args.task_id);
  return slimMutationResponse(persisted, { submitted_at: persisted.submitted_at });
}
