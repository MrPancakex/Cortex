// Bridge message schemas for the Cortex inter-agent bus.
//
// A bridge message is a typed envelope sent from one agent (or the orchestrator)
// to another. The discriminated union on `kind` enforces per-kind required
// fields so handlers can destructure after a single `parse()` call at the
// trust boundary (MCP, HTTP, or CLI).
import { z } from 'zod';

const BaseBridge = z.object({
  to: z.string().min(1),
  from: z.string().optional(),
  task_id: z.string().optional(),
  in_reply_to: z.string().optional(),
  priority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  expires_at: z.string().datetime().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

export const BridgeSendSchema = z.discriminatedUnion('kind', [
  BaseBridge.extend({ kind: z.literal('message'), content: z.string().min(1) }),
  BaseBridge.extend({
    kind: z.literal('question'),
    question_id: z.string().min(1),
    content: z.string().min(1),
    options: z.array(z.string()).optional(),
  }),
  BaseBridge.extend({
    kind: z.literal('answer'),
    question_id: z.string().min(1),
    content: z.string(),
  }),
  BaseBridge.extend({ kind: z.literal('directive'), content: z.string().min(1) }),
  BaseBridge.extend({ kind: z.literal('ack') }),
  BaseBridge.extend({ kind: z.literal('nudge'), content: z.string().optional() }),
]);

export const BridgeInboxSchema = z.object({
  agent_id: z.string().min(1).optional(),
  summary_only: z.boolean().optional(),
  limit: z.number().int().positive().max(500).optional(),
  since: z.string().datetime().optional(),
});
