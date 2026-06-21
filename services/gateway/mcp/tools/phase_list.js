import { z } from 'zod';
import { gatewayJson } from './_shared.js';

export const PhaseListInputSchema = z.object({
  project_id: z.string().min(1),
});

export const definition = {
  name: 'phase_list',
  protocolVersion: '1.0',
  description: 'List all phases in a project with completion status.',
  inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] },
  schema: PhaseListInputSchema,
  capability: 'phase.read',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  return gatewayJson(gateway, `/v1/api/projects/${encodeURIComponent(args.project_id)}/phases`);
}
