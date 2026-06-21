import { z } from 'zod';
import { gatewayJson } from './_shared.js';

export const PhaseDeleteInputSchema = z.object({
  project_id: z.string().min(1),
  phase_number: z.number().int().positive(),
});

export const definition = {
  name: 'phase_delete',
  protocolVersion: '1.0',
  description: 'Delete a phase and all its tasks from a project. Admin only.',
  inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, phase_number: { type: 'integer' } }, required: ['project_id', 'phase_number'] },
  schema: PhaseDeleteInputSchema,
  capability: 'phase.delete',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  return gatewayJson(gateway, `/v1/api/projects/${encodeURIComponent(args.project_id)}/phases/${args.phase_number}`, { method: 'DELETE' });
}
