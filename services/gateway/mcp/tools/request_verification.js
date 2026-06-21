import { gatewayJson, persistTaskState, slimMutationResponse } from './_shared.js';
import { RequestVerificationSchema } from '@cortex/core/schemas';

export const definition = {
  name: 'request_verification',
  protocolVersion: '1.0',
  description: 'Move a submitted task into review and assign a reviewer.',
  inputSchema: {
    type: 'object',
    properties: {
      task_id: { type: 'string' },
      reviewer: { type: 'string' },
    },
    required: ['task_id', 'reviewer'],
  },
  schema: RequestVerificationSchema,
  capability: 'task.review',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  const response = await gatewayJson(
    gateway,
    `/v1/api/tasks/${encodeURIComponent(args.task_id)}/request-review`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reviewer: args.reviewer, summary: args.summary }),
    },
  );
  const persisted = await persistTaskState(gateway, response, 'sync', args.task_id);
  return slimMutationResponse(persisted, { reviewer_agent: persisted.reviewer_agent });
}
