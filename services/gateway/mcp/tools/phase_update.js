import { z } from 'zod';
import { swallow } from '@cortex/sdk/errors';

export const PhaseUpdateInputSchema = z.object({
  project_id: z.string().min(1),
  phase_number: z.number().int().positive(),
  description: z.string().optional(),
});

export const definition = {
  name: 'phase_update',
  protocolVersion: '1.0',
  description: 'Rename or renumber a phase in a project (description updates). Admin-only.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string' },
      phase_number: { type: 'integer' },
      description: { type: 'string' },
    },
    required: ['project_id', 'phase_number'],
  },
  schema: PhaseUpdateInputSchema,
  capability: 'phase.update',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  const phaseNumber = Number(args.phase_number);
  if (!Number.isInteger(phaseNumber) || phaseNumber < 1) {
    throw new Error('phase_number must be a positive integer');
  }
  const db = gateway.db;
  if (!db) throw new Error('gateway.db not available');
  const stmts = gateway.stmts;
  const project = stmts?.getProject?.get(args.project_id);
  if (!project) throw new Error('project not found');
  const phaseCount = project.phase_count ?? 1;
  if (phaseNumber > phaseCount) {
    throw new Error(`phase ${phaseNumber} does not exist (project has ${phaseCount} phase(s))`);
  }
  try {
    const exists = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_phases'`
    ).get();
    if (exists && args.description !== undefined) {
      db.prepare(
        `INSERT INTO project_phases (project_id, phase_number, description, updated_at)
         VALUES (?, ?, ?, unixepoch())
         ON CONFLICT(project_id, phase_number)
         DO UPDATE SET description = excluded.description, updated_at = unixepoch()`
      ).run(args.project_id, phaseNumber, args.description || null);
    }
  } catch (err) { swallow('phase_update_description_failed', err); }
  return { project_id: args.project_id, phase_number: phaseNumber, updated: true };
}
