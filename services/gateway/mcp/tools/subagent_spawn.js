import { z } from 'zod';
import { notImplementedStub } from './_shared.js';

export const SubagentSpawnInputSchema = z.object({
  prompt: z.string().min(1),
  subagent_type: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  task_id: z.string().optional(),
  cwd: z.string().optional(),
});

export const definition = {
  name: 'subagent_spawn',
  protocolVersion: '1.0',
  description: '[stub] Spawn a sub-agent process owned and managed by Cortex.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      subagent_type: { type: 'string' },
      model: { type: 'string' },
      provider: { type: 'string' },
      task_id: { type: 'string' },
      cwd: { type: 'string' },
    },
    required: ['prompt'],
  },
  schema: SubagentSpawnInputSchema,
  capability: 'subagent.spawn',
};

export async function handler(args, _gateway) {
  const parsed = definition.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  return notImplementedStub({
    reason: 'subagent_mcp_tool_intentionally_stubbed',
    tracking: 'bot CLAUDE.md §Orchestrator Mode — STUBS; docs/cortex-rebuild-home-check.md §12.6 Plane 1',
    detail: 'The /v1/api/subagents/* HTTP routes ARE mounted (services/gateway/subagents/routes.js via composer.js mountSubagentRoutes; route-manifest.js subagent_spawn/wait/close). This MCP tool wrapper is intentionally left a not_implemented stub per CLAUDE.md policy — agents use the native sub-agent path, not this tool, until the bounded-subagent plane is promoted out of stub status. Tool-impl maturity, not a missing route.',
  });
}
