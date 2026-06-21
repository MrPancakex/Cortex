import { z } from 'zod';
import { gatewayJson } from './_shared.js';

export const TaskBatchStatusInputSchema = z.object({
  task_ids: z.array(z.string().min(1)).min(1).max(50),
});

export const definition = {
  name: 'task_batch_status',
  protocolVersion: '1.0',
  description: 'Get status of multiple tasks in one call.',
  inputSchema: { type: 'object', properties: { task_ids: { type: 'array', items: { type: 'string' } } }, required: ['task_ids'] },
  schema: TaskBatchStatusInputSchema,
  capability: 'task.read',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  const results = await Promise.all(
    args.task_ids.map(id =>
      gatewayJson(gateway, `/v1/api/tasks/${encodeURIComponent(id)}`).catch(e => ({ id, error: e.message }))
    )
  );
  return {
    tasks: results.map(t => ({
      id: t.id, title: t.title, status: t.status,
      assigned_agent: t.assigned_agent,
      error: t.error || undefined,
    })),
    total: results.length,
  };
}
