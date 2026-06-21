/**
 * session.* event payload schemas. Session lifecycle:
 *   opened → (heartbeat)* → closed | expired
 */
import { z } from 'zod';
import { AgentIdSchema } from '../_primitives.js';

const SessionIdSchema = z.string().min(1);

export const SessionOpenedEventSchema = z.object({
  session_id: SessionIdSchema,
  base_agent: AgentIdSchema,
  slot: z.number().int().positive(),
  pid: z.number().int().positive(),
  opened_at: z.number().int().nonnegative(),
});

export const SessionHeartbeatEventSchema = z.object({
  session_id: SessionIdSchema,
  base_agent: AgentIdSchema,
  ts: z.number().int().nonnegative(),
});

export const SessionExpiredEventSchema = z.object({
  session_id: SessionIdSchema,
  base_agent: AgentIdSchema,
  reason: z.enum(['pid_dead', 'heartbeat_timeout', 'lease_corrupt', 'force_release']),
  // Optional free-text forensic context — e.g. the pid that expired,
  // the stale heartbeat age, or the specific lease path for debugging.
  detail: z.string().optional(),
  expired_at: z.number().int().nonnegative(),
});

export const SessionClosedEventSchema = z.object({
  session_id: SessionIdSchema,
  base_agent: AgentIdSchema,
  closed_at: z.number().int().nonnegative(),
});

export const SessionEventPayloadMap = {
  'session.opened': SessionOpenedEventSchema,
  'session.heartbeat': SessionHeartbeatEventSchema,
  'session.expired': SessionExpiredEventSchema,
  'session.closed': SessionClosedEventSchema,
};
