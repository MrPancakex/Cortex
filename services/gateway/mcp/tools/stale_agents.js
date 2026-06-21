import { z } from 'zod';
import { notImplementedStub } from './_shared.js';

export const StaleAgentsInputSchema = z.object({
  seconds: z.number().int().positive().optional(),
});

export const definition = {
  name: 'stale_agents',
  protocolVersion: '1.0',
  description: '[stub] List agents that have not heartbeated within a threshold.',
  inputSchema: { type: 'object', properties: { seconds: { type: 'integer' } }, required: [] },
  schema: StaleAgentsInputSchema,
  capability: 'agent.read',
};

export async function handler(args, _gateway) {
  const parsed = definition.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  return notImplementedStub({
    reason: 'stale_agents_route_not_mounted',
    tracking: 'docs/cortex-rebuild-port-audit-2026-04-24.md §2.2 Identity/health',
    detail: 'The gateway does not yet mount a /v1/api/agents/stale endpoint. Stale-agent detection is available via the release_stale_agent_tasks tool which reads DB directly.',
  });
}
