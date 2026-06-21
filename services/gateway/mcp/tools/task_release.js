import { z } from 'zod';
import { gatewayJson, persistTaskState } from './_shared.js';
import { getAgentId } from '@cortex/sdk/auth';
import { failTaskWorker, lookupRunningTaskWorker } from '@cortex/sdk/sessions';
import { swallow } from '@cortex/sdk/errors';

export const TaskReleaseInputSchema = z.object({
  task_id: z.string().min(1),
  reason: z.string().optional(),
});

export const definition = {
  name: 'task_release',
  protocolVersion: '1.0',
  description: 'Release a claimed or in-progress task back to pending.',
  inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, reason: { type: 'string' } }, required: ['task_id'] },
  schema: TaskReleaseInputSchema,
  capability: 'task.release',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  const response = await gatewayJson(gateway, `/v1/api/tasks/${encodeURIComponent(args.task_id)}/release`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: args.reason || null }),
  });
  // Release is a terminal exit path for the worker even though the task
  // returns to pending. Close the lifecycle ledger row stamped at claim
  // so the dashboard doesn't show this agent as still working on it.
  // Owner-scoped via parentAgent. Best-effort.
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
          failTaskWorker({
            db: gateway.db,
            eventId,
            parentAgent,
            reason: `task_released: ${args.reason || 'unspecified'}`,
          });
        }
      }
    } catch (err) {
      swallow('mcp.task_release_close_subagent_failed', err);
    }
  }
  return persistTaskState(gateway, response, 'clear', args.task_id);
}
