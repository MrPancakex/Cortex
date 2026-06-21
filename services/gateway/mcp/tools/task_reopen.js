import { z } from 'zod';
import { gatewayJson, persistTaskState, slimMutationResponse } from './_shared.js';

export const TaskReopenInputSchema = z.object({
  task_id: z.string().min(1),
  reason: z.string().min(1),
});

export const definition = {
  name: 'task_reopen',
  protocolVersion: '1.0',
  description: 'Reopen an approved or rejected task as pending.',
  inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, reason: { type: 'string' } }, required: ['task_id', 'reason'] },
  schema: TaskReopenInputSchema,
  capability: 'task.reopen',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  const response = await gatewayJson(gateway, `/v1/api/tasks/${encodeURIComponent(args.task_id)}/reopen`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: args.reason }),
  });
  const persisted = await persistTaskState(gateway, response, 'clear', args.task_id);
  return slimMutationResponse(persisted);
}
