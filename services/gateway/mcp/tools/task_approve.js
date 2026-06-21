import { z } from 'zod';
import { gatewayJson } from './_shared.js';

export const TaskApproveInputSchema = z.object({
  task_id: z.string().min(1),
  comment: z.string().optional(),
});

export const definition = {
  name: 'task_approve',
  protocolVersion: '1.0',
  description: 'Approve a task in review.',
  inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, comment: { type: 'string' } }, required: ['task_id'] },
  schema: TaskApproveInputSchema,
  capability: 'task.review',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  return gatewayJson(gateway, `/v1/api/tasks/${encodeURIComponent(args.task_id)}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ comment: args.comment || null }),
  });
}
