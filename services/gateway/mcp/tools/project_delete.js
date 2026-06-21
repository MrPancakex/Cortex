import { z } from 'zod';
import { gatewayJson } from './_shared.js';

export const ProjectDeleteInputSchema = z.object({
  project_id: z.string().min(1),
});

export const definition = {
  name: 'project_delete',
  protocolVersion: '1.0',
  description: 'Request deletion of a project and all its tasks. Flags it for deletion only — an admin must approve-delete before anything is removed.',
  inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] },
  schema: ProjectDeleteInputSchema,
  capability: 'project.delete',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  return gatewayJson(gateway, `/v1/api/projects/${encodeURIComponent(args.project_id)}/request-delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'Deletion requested by agent' }),
  });
}
