// Bridge message schemas for the Cortex inter-agent bus.
//
// A bridge message is a typed envelope sent from one agent (or the orchestrator)
// to another. The discriminated union on `kind` enforces per-kind required
// fields so handlers can destructure after a single `parse()` call at the
// trust boundary (MCP, HTTP, or CLI).
//
// Phase 1 — lifted verbatim from shared/schemas/bridge.js. The broader
// persisted-message shape (BridgeMessageSchema), reply/broadcast/system
// kinds, and delivery state surface arrive in Phase 4.
import { z } from 'zod';

const BaseBridge = z.object({
  to: z.string().min(1),
  from: z.string().optional(),
  subject: z.string().optional(),
  task_id: z.string().optional(),
  in_reply_to: z.string().optional(),
  priority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  expires_at: z.string().datetime().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  target_session: z.string().min(1).optional(),
  sender_session: z.string().min(1).optional(),
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

// Phase 4 additions — surface for the persisted-message contract.

/**
 * Canonical enumeration of bridge message kinds. Mirrors the discriminator
 * of BridgeSendSchema so callers enumerating the valid wire types don't
 * need to reach into the union shape directly.
 */
export const BridgeTypeSchema = z.enum([
  'message',
  'question',
  'answer',
  'directive',
  'ack',
  'nudge',
]);

/**
 * Delivery-state lifecycle for a persisted bridge message. A row
 * progresses `pending → delivered → (read | acked)`. `read` and `acked`
 * are distinct terminal states: `read` means the recipient's UI
 * surfaced the message; `acked` means the recipient explicitly
 * acknowledged (e.g. dismissed a notification or confirmed a
 * directive). A message may skip states — e.g. a plugin subscriber
 * that never surfaces UI may move directly from `delivered` to `acked`.
 */
export const BridgeDeliveryStateSchema = z.enum([
  'pending',
  'delivered',
  'read',
  'acked',
]);

/**
 * Persisted bridge message row shape (matches the bridge_messages
 * columns in the initial migration). `body` is the human-readable
 * message body derived from the send-time payload; `metadata` is an
 * opaque JSON string the sender can round-trip (typed-field fallbacks,
 * context, options, etc.).
 */
export const BridgeMessageSchema = z.object({
  id: z.string().min(1),
  from_agent: z.string().min(1),
  to_agent: z.string().min(1),
  task_id: z.string().nullable().optional(),
  thread_id: z.string().nullable().optional(),
  reply_to: z.string().nullable().optional(),
  type: BridgeTypeSchema,
  subject: z.string().optional(),
  body: z.string(),
  metadata: z.string(),
  read_at: z.string().nullable().optional(),
  acked_at: z.string().nullable().optional(),
  created_at: z.string(),
});
