import { z } from 'zod';
import { gatewayJson, persistTaskState, slimMutationResponse } from './_shared.js';
import { agentContext, getAgentId } from '@cortex/sdk/auth';
import { registerTaskWorker } from '@cortex/sdk/sessions';
import { swallow } from '@cortex/sdk/errors';

export const ClaimTaskInputSchema = z.object({
  task_id: z.string().min(1),
});

export const definition = {
  name: 'claim_task',
  protocolVersion: '1.0',
  description: 'Claim an existing pending task.',
  inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  schema: ClaimTaskInputSchema,
  capability: 'task.claim',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  const { platform } = agentContext(gateway);
  const response = await gatewayJson(gateway, `/v1/api/tasks/${encodeURIComponent(args.task_id)}/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform }),
  });
  // Stamp a subagent_events 'task-worker' row so the dashboard can render
  // "agent is working on task X right now". Direct DB write — no HTTP.
  // Best-effort: a missing db handle (test harness without migrations
  // applied, or pre-cutover bot pointing at a stale DB) is swallowed
  // rather than failing the claim, since the claim itself already
  // succeeded and the audit trail is observability, not correctness.
  if (response.title && gateway.db) {
    try {
      const eventId = registerTaskWorker({
        db: gateway.db,
        parentAgent: getAgentId(gateway),
        taskId: args.task_id,
        taskTitle: response.title,
      });
      if (eventId) response._subagent_event_id = eventId;
    } catch (err) {
      swallow('mcp.claim_task_register_subagent_failed', err);
    }
  }
  const persisted = await persistTaskState(gateway, response, 'sync', args.task_id);
  return slimMutationResponse(persisted, { assigned_to: persisted.assigned_to });
}
