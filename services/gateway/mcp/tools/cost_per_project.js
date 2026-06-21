import { z } from 'zod';
import { costForProject } from '../../meta/telemetry.js';

export const CostPerProjectInputSchema = z.object({
  project_id: z.string().min(1),
});

export const definition = {
  name: 'cost_per_project',
  protocolVersion: '1.0',
  description: 'Aggregate cost / token / request usage for a single project.',
  inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] },
  schema: CostPerProjectInputSchema,
  capability: 'cost.read',
};

// Foundation F R1-1: wired to REAL per-project aggregates over telemetry ∪
// proxy_logs (disjoint by migration-016 design). Aggregates in-process from the
// gateway DB via meta/telemetry.js — does NOT depend on proxy/cost-routes.js
// (broken on this branch). A project with no rows aggregates to genuine zeros.
export async function handler(args, _gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  const projectId = parsed.data.project_id;
  const totals = costForProject(projectId);
  return {
    ok: true,
    project_id: projectId,
    total_requests: totals.requests,
    total_tokens_in: totals.tokens_in,
    total_tokens_out: totals.tokens_out,
    total_cost_usd: totals.total_cost_usd,
  };
}
