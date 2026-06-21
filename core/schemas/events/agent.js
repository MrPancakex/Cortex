/**
 * agent.* event payload schemas. Agent registry changes.
 */
import { z } from 'zod';
import { AgentIdSchema } from '../_primitives.js';

export const AgentRegisteredEventSchema = z.object({
  agent_id: AgentIdSchema,
  platform: z.string().min(1).optional(),
  registered_at: z.number().int().nonnegative(),
});

export const AgentUpdatedEventSchema = z.object({
  agent_id: AgentIdSchema,
  fields: z.record(z.string(), z.unknown()),
  updated_at: z.number().int().nonnegative(),
});

export const AgentStaleEventSchema = z.object({
  agent_id: AgentIdSchema,
  last_heartbeat_at: z.number().int().nonnegative(),
  detected_at: z.number().int().nonnegative(),
});

export const AgentEventPayloadMap = {
  'agent.registered': AgentRegisteredEventSchema,
  'agent.updated': AgentUpdatedEventSchema,
  'agent.stale': AgentStaleEventSchema,
};
