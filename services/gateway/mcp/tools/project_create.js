import { z } from 'zod';
import { gatewayJson } from './_shared.js';

// Bounds mirror the POST /v1/api/projects route (ProjectCreateSchema in
// project-routes.js): name min(1).max(200), description max(5000),
// default_reviewer max(100). default_reviewer is optional + non-nullable on
// create — unlike update, there is nothing to clear, and the route rejects null.
export const ProjectCreateInputSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  default_reviewer: z.string().max(100).optional(),
});

export const definition = {
  name: 'project_create',
  protocolVersion: '1.0',
  description: 'Create a project. Optionally set a default reviewer for all tasks in this project.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      default_reviewer: { type: 'string' },
    },
    required: ['name'],
  },
  schema: ProjectCreateInputSchema,
  capability: 'project.create',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  // Presence-based body: the route's create schema is name(min 1) +
  // description.optional() + default_reviewer.optional() (non-nullable). Build
  // only the fields the caller supplied so we never emit `description: null`
  // (which the route rejects with invalid_body) and so default_reviewer —
  // previously advertised but dropped — is forwarded when present.
  const body = { name: args.name };
  if (args.description !== undefined) body.description = args.description;
  if (args.default_reviewer !== undefined) body.default_reviewer = args.default_reviewer;
  return gatewayJson(gateway, '/v1/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
