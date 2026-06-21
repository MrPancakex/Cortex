import { z } from 'zod';
import { gatewayJson } from './_shared.js';

export const TaskAuditInputSchema = z.object({
  task_id: z.string().min(1),
});

export const definition = {
  name: 'task_audit',
  protocolVersion: '1.0',
  description: 'View the full audit trail for a task — every state change, who did it, when.',
  inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  schema: TaskAuditInputSchema,
  capability: 'task.read',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  return gatewayJson(gateway, `/v1/api/tasks/${encodeURIComponent(args.task_id)}/audit`);
}
