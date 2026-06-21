import { z } from 'zod';
import { gatewayJson } from './_shared.js';

export const TaskCommentInputSchema = z.object({
  task_id: z.string().min(1),
  comment: z.string().min(1),
});

export const definition = {
  name: 'task_comment',
  protocolVersion: '1.0',
  description: 'Add a note to a task.',
  inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, comment: { type: 'string' } }, required: ['task_id', 'comment'] },
  schema: TaskCommentInputSchema,
  capability: 'task.comment',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  return gatewayJson(gateway, `/v1/api/tasks/${encodeURIComponent(args.task_id)}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ comment: args.comment }),
  });
}
