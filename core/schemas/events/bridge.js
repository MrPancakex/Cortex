/**
 * bridge.* event payload schemas. Agent-to-agent message delivery.
 */
import { z } from 'zod';
import { AgentIdSchema } from '../_primitives.js';

const MessageIdSchema = z.string().uuid();

export const BridgeSentEventSchema = z.object({
  message_id: MessageIdSchema,
  from_agent: AgentIdSchema,
  to_agent: AgentIdSchema,
  subject: z.string().optional(),
  // task_id and thread_id are non-empty strings (not strict UUIDs)
  // because legacy task ids can carry prefixes and thread_id references
  // a message id that the wider system treats as an opaque token. Requiring
  // .uuid() here previously silently dropped bridge.sent events whose
  // task_id didn't pass strict UUID validation.
  task_id: z.string().min(1).optional(),
  thread_id: z.string().min(1).optional(),
  sent_at: z.number().int().nonnegative(),
  target_session: z.string().min(1).optional(),
  sender_session: z.string().min(1).optional(),
});

export const BridgeDeliveredEventSchema = z.object({
  message_id: MessageIdSchema,
  to_agent: AgentIdSchema,
  delivered_at: z.number().int().nonnegative(),
});

export const BridgeReadEventSchema = z.object({
  message_id: MessageIdSchema,
  reader: AgentIdSchema,
  read_at: z.number().int().nonnegative(),
});

export const BridgeRepliedEventSchema = z.object({
  message_id: MessageIdSchema,
  reply_message_id: MessageIdSchema,
  from_agent: AgentIdSchema,
  // to_agent is the ORIGINAL message's sender — i.e. the agent who
  // should be notified that their message got a reply. Required so
  // the socket-bridge fanout can route the event to a WS frame
  // (replied events are otherwise undeliverable via the generic
  // `to_agent || reader` lookup in socket-bridge.js).
  to_agent: AgentIdSchema,
  replied_at: z.number().int().nonnegative(),
});

export const BridgeHistoryReadEventSchema = z.object({
  actor: AgentIdSchema,
  route: z.literal('/v1/api/bridge/history'),
  filters: z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    type: z.string().optional(),
    task_id: z.string().optional(),
    since: z.string().optional(),
    until: z.string().optional(),
  }).strict(),
  row_count: z.number().int().nonnegative(),
  cursor: z.string().nullable(),
  next_cursor: z.string().nullable(),
  read_at: z.number().int().nonnegative(),
});

export const BridgeEventPayloadMap = {
  'bridge.sent': BridgeSentEventSchema,
  'bridge.delivered': BridgeDeliveredEventSchema,
  'bridge.read': BridgeReadEventSchema,
  'bridge.replied': BridgeRepliedEventSchema,
  'bridge.history_read': BridgeHistoryReadEventSchema,
};
