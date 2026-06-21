import { gatewayJson, persistTaskState, slimMutationResponse } from './_shared.js';
import { ProgressReportSchema } from '@cortex/core/schemas';

export const definition = {
  name: 'report_progress',
  protocolVersion: '1.0',
  description: 'Report progress on a claimed or in-progress task.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string' },
      status: { type: 'string', enum: ['planning', 'implementation', 'in_progress', 'testing', 'reviewing'] },
      summary: { type: 'string' },
      files_changed: { type: 'array', items: { type: 'string' } },
    },
    required: ['task_id', 'status', 'summary'],
  },
  schema: ProgressReportSchema,
  capability: 'task.progress',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse({
    ...args,
    files_changed: args.files_changed ?? undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  const response = await gatewayJson(gateway, `/v1/api/tasks/${encodeURIComponent(args.task_id)}/progress`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      status: args.status,
      summary: args.summary,
      files_changed: args.files_changed || [],
    }),
  });
  const persisted = await persistTaskState(gateway, response, 'sync', args.task_id);
  return slimMutationResponse(persisted, { progress_count: persisted.progress_count });
}
