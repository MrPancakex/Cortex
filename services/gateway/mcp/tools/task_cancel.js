import { z } from 'zod';
import { gatewayJson } from './_shared.js';
import { getAgentId } from '@cortex/sdk/auth';
import { failTaskWorker, lookupRunningTaskWorker } from '@cortex/sdk/sessions';
import { swallow } from '@cortex/sdk/errors';

export const TaskCancelInputSchema = z.object({
  task_id: z.string().min(1),
  reason: z.string().min(1),
});

export const definition = {
  name: 'task_cancel',
  protocolVersion: '1.0',
  description: 'Cancel a task permanently.',
  inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, reason: { type: 'string' } }, required: ['task_id', 'reason'] },
  schema: TaskCancelInputSchema,
  capability: 'task.cancel',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  const response = await gatewayJson(gateway, `/v1/api/tasks/${encodeURIComponent(args.task_id)}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: args.reason }),
  });
  // Close out the matching subagent_events row stamped by claim_task. Cancel
  // is a terminal exit path; without this, status='running' rows accumulate
  // forever and the orphan reaper / dashboard show stale activity.
  // Owner-scoped via parentAgent in both lookup and the WHERE clause.
  // Best-effort: a missing row (cancel of a never-claimed task) is swallowed.
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
            reason: `task_cancelled: ${args.reason}`,
          });
        }
      }
    } catch (err) {
      swallow('mcp.task_cancel_close_subagent_failed', err);
    }
  }
  return response;
}
