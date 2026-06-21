import { z } from 'zod';
import { gatewayJson } from './_shared.js';

export const ProjectListInputSchema = z.object({}).passthrough();

export const definition = {
  name: 'project_list',
  protocolVersion: '1.0',
  description: 'List projects.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  schema: ProjectListInputSchema,
  capability: 'project.read',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  return gatewayJson(gateway, '/v1/api/projects');
}
