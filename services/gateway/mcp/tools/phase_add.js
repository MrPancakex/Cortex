import { z } from 'zod';
import { gatewayJson } from './_shared.js';

export const PhaseAddInputSchema = z.object({
  project_id: z.string().min(1),
});

export const definition = {
  name: 'phase_add',
  protocolVersion: '1.0',
  description: 'Add a new phase to a project. Creates the phase folder and PHASE-README.md.',
  inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] },
  schema: PhaseAddInputSchema,
  capability: 'phase.create',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  return gatewayJson(gateway, `/v1/api/projects/${encodeURIComponent(args.project_id)}/phases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}
