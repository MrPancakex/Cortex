import { z } from 'zod';
import { gatewayJson } from './_shared.js';

export const ProjectGetInputSchema = z.object({
  project_id: z.string().min(1),
});

export const definition = {
  name: 'project_get',
  protocolVersion: '1.0',
  description: 'Fetch a project with task detail.',
  inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] },
  schema: ProjectGetInputSchema,
  capability: 'project.read',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  return gatewayJson(gateway, `/v1/api/projects/${encodeURIComponent(args.project_id)}`);
}
