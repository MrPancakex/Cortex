import { z } from 'zod';
import { clearActiveProject } from '@cortex/sdk/sessions';

export const ProjectDisconnectInputSchema = z.object({}).passthrough();

export const definition = {
  name: 'project_disconnect',
  protocolVersion: '1.0',
  description: 'Disconnect from the active project. Removes the runtime active-project file.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  schema: ProjectDisconnectInputSchema,
  capability: 'project.connect',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  await clearActiveProject(gateway);
  return { disconnected: true };
}
