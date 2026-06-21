import { z } from 'zod';
import { notImplementedStub } from './_shared.js';

export const SubagentWaitInputSchema = z.object({
  subagent_id: z.string().min(1),
});

export const definition = {
  name: 'subagent_wait',
  protocolVersion: '1.0',
  description: '[stub] Poll a Cortex-owned sub-agent for its current status and result.',
  inputSchema: { type: 'object', properties: { subagent_id: { type: 'string' } }, required: ['subagent_id'] },
  schema: SubagentWaitInputSchema,
  capability: 'subagent.read',
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
