import { z } from 'zod';
import { gatewayJson, persistTaskState } from './_shared.js';

export const TaskReassignInputSchema = z.object({
  task_id: z.string().min(1),
  new_agent: z.string().min(1),
});

export const definition = {
  name: 'task_reassign',
  protocolVersion: '1.0',
  description: 'Reassign a task to another agent as pending.',
  inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, new_agent: { type: 'string' } }, required: ['task_id', 'new_agent'] },
  schema: TaskReassignInputSchema,
  capability: 'task.reassign',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  const response = await gatewayJson(gateway, `/v1/api/tasks/${encodeURIComponent(args.task_id)}/reassign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ new_agent: args.new_agent }),
  });
  return persistTaskState(gateway, response, 'clear', args.task_id);
}
