import { z } from 'zod';
import { gatewayJson } from './_shared.js';

export const TaskRejectInputSchema = z.object({
  task_id: z.string().min(1),
  reason: z.string().min(1),
  guidance: z.string().optional(),
});

export const definition = {
  name: 'task_reject',
  protocolVersion: '1.0',
  description: 'Reject a task in review.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string' },
      reason: { type: 'string' },
      guidance: { type: 'string' },
    },
    required: ['task_id', 'reason'],
  },
  schema: TaskRejectInputSchema,
  capability: 'task.review',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  return gatewayJson(gateway, `/v1/api/tasks/${encodeURIComponent(args.task_id)}/reject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: args.reason, guidance: args.guidance || null }),
  });
}
