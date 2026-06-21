import { z } from 'zod';
import { gatewayJson } from './_shared.js';
import { writeActiveProject } from '@cortex/sdk/sessions';

export const ProjectConnectInputSchema = z.object({
  project_id: z.string().min(1),
});

export const definition = {
  name: 'project_connect',
  protocolVersion: '1.0',
  description: 'Connect to a project. Writes project ID to the runtime active-project file so the gate allows writes.',
  inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] },
  schema: ProjectConnectInputSchema,
  capability: 'project.connect',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  const project = await gatewayJson(gateway, `/v1/api/projects/${encodeURIComponent(args.project_id)}`);
  if (!project || project.error) throw new Error('project not found');
  const projectFile = await writeActiveProject(gateway, args.project_id);
  return {
    connected: true,
    project_id: args.project_id,
    project_name: project.name || null,
    scope: '~/Cortex',
    project_file: projectFile,
  };
}
