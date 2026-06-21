import { gatewayJson } from './_shared.js';
import { TaskCreateSchema } from '@cortex/core/schemas';

export const definition = {
  name: 'task_create',
  protocolVersion: '1.0',
  description: 'Create a new task in pending status and sync the task folder on disk. Requires project_id. phase_number defaults to the latest phase.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      project_id: { type: 'string', description: 'UUID of the project' },
      phase_number: { type: 'integer' },
      priority: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      section: { type: 'string', description: 'Task style/category, e.g. "MCP & Tools".' },
    },
    required: ['title', 'project_id'],
  },
  schema: TaskCreateSchema,
  capability: 'task.create',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  let phaseNumber = args.phase_number;
  if (!phaseNumber) {
    // v2 phase rows expose `ordinal` (0-based, contiguous), not `phase_number`.
    // Malformed rows missing ordinal collapse to a -1 sentinel so they can't
    // inflate the max past 0; +1 converts back to the 1-based phase_number
    // the task route expects.
    const phases = await gatewayJson(gateway, `/v1/api/projects/${encodeURIComponent(args.project_id)}/phases`);
    phaseNumber = phases.phases && phases.phases.length > 0
      ? Math.max(0, ...phases.phases.map(p => Number.isInteger(p.ordinal) ? p.ordinal : -1)) + 1
      : 1;
  }
  const body = {
    title: args.title,
    description: args.description,
    project_id: args.project_id,
    phase_number: phaseNumber,
    priority: args.priority || 'medium',
    tags: args.tags || [],
  };
  // Forward section only when supplied — createTask stores it in metadata
  // only when present, so an omitted section keeps the row's metadata clean.
  if (args.section !== undefined) body.section = args.section;
  return gatewayJson(gateway, '/v1/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
