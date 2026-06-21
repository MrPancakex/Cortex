import { z } from 'zod';
import { gatewayJson, slimMutationResponse } from './_shared.js';

export const TaskUpdateInputSchema = z.object({
  task_id: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  priority: z.string().optional(),
  tags: z.array(z.string()).optional(),
  // section — nullable so an explicit null reaches the handler's clear-the-bucket
  // path (transitions.js updateTask); undefined means "leave it unchanged".
  section: z.string().nullable().optional(),
});

export const definition = {
  name: 'task_update',
  protocolVersion: '1.0',
  description: 'Update task metadata without changing task state.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      priority: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      section: { type: ['string', 'null'], description: 'Task style/category, e.g. "MCP & Tools". Pass null to clear.' },
    },
    required: ['task_id'],
  },
  schema: TaskUpdateInputSchema,
  capability: 'task.update',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  const body = {};
  if (args.title !== undefined) body.title = args.title;
  if (args.description !== undefined) body.description = args.description;
  if (args.priority !== undefined) body.priority = args.priority;
  if (args.tags !== undefined) body.tags = args.tags;
  // Forward section verbatim when the caller set it (including explicit null
  // to clear); omitting it leaves the existing section untouched.
  if (args.section !== undefined) body.section = args.section;
  const response = await gatewayJson(gateway, `/v1/api/tasks/${encodeURIComponent(args.task_id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  // Slim mutation shape (contract revision note e):
  //   {task_id, id, fields_changed, updated_at, next_step_hint}
  // title is intentionally NOT echoed — the route returns it but the slim shape
  // drops it; the caller learns what changed via fields_changed (which will
  // contain 'title' when it was updated).  Echoing title would violate the
  // documented slim contract and was the subject of Finding 2 (TE-5 R3).
  //
  // priority and tags are also NOT echoed for the same reason: the documented
  // slim shape is {task_id, id, fields_changed, updated_at, next_step_hint}
  // and section is excluded (ROOT 2 fix: the PATCH route transitions.js:1093
  // does not return section so echoing it would synthesise a null value).
  const extra = {};
  // Always preserve these fields from the route body when present.
  if (Array.isArray(response.fields_changed)) extra.fields_changed = response.fields_changed;
  if (response.updated_at != null) extra.updated_at = response.updated_at;
  return slimMutationResponse(response, extra);
}
