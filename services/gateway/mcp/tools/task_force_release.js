import { z } from 'zod';
import { gatewayJson } from './_shared.js';

export const TaskForceReleaseInputSchema = z.object({
  task_id: z.string().min(1),
  reason: z.string().optional(),
});

export const definition = {
  name: 'task_force_release',
  protocolVersion: '1.0',
  description: 'Forcibly release a task assigned to another agent. Admin-only.',
  inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, reason: { type: 'string' } }, required: ['task_id'] },
  schema: TaskForceReleaseInputSchema,
  capability: 'admin.release',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  return gatewayJson(gateway, `/v1/api/tasks/${encodeURIComponent(args.task_id)}/release`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: args.reason || 'force-released by admin', force: true }),
  });
}
