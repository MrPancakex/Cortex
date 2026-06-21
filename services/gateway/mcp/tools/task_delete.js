import { z } from 'zod';
import { gatewayJson } from './_shared.js';

export const TaskDeleteInputSchema = z.object({
  task_id: z.string().min(1),
  reason: z.string().optional(),
});

export const definition = {
  name: 'task_delete',
  protocolVersion: '1.0',
  description: 'Permanently delete a task and its workspace folder. Admin only.',
  inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  schema: TaskDeleteInputSchema,
  capability: 'task.delete',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  return gatewayJson(gateway, `/v1/api/tasks/${encodeURIComponent(args.task_id)}/request-delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: args.reason || 'Deletion requested by agent' }),
  });
}
