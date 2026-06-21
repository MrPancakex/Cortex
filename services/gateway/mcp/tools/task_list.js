import { z } from 'zod';
import { gatewayJson } from './_shared.js';

export const TaskListInputSchema = z.object({
  status: z.string().optional(),
  agent: z.string().optional(),
  project_id: z.string().optional(),
  source: z.string().optional(),
  limit: z.number().int().positive().max(500).optional(),
});

export const definition = {
  name: 'task_list',
  protocolVersion: '1.0',
  description: 'List tasks with optional filters.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string' },
      agent: { type: 'string' },
      project_id: { type: 'string' },
      source: { type: 'string' },
      limit: { type: 'number' },
    },
    required: [],
  },
  schema: TaskListInputSchema,
  capability: 'task.read',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  const limit = args.limit || 50;
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (args.status) params.set('status', args.status);
  if (args.agent) params.set('agent', args.agent);
  if (args.project_id) params.set('project_id', args.project_id);
  if (args.source) params.set('source', args.source);
  // task_list is already compact at the HTTP layer: the route uses serializeTaskSummary
  // which returns scalar fields only (no journal/comments/progress_reports arrays).
  // No MCP-layer stripping is needed — the HTTP route is the compaction point.
  // Verified by: serializeTaskSummary in tasks/serialize.js returns no nested arrays.
  return gatewayJson(gateway, `/v1/api/tasks?${params.toString()}`);
}
