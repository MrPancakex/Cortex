// Agent-domain schemas consumed by both the gateway (Phase 3 contract layer)
// and the dashboard frontend (Phase 9 typed fetch layer).
//
// The three originals (AgentStatusSchema, AgentIdSchema, TaskIdSchema) are
// preserved verbatim for Phase 9 compatibility. Phase 3 adds the broader
// agent-register / agent-status / heartbeat schemas used at MCP and HTTP
// trust boundaries.
import { z } from 'zod';

/**
 * Agent runtime status as surfaced to the dashboard.
 * The gateway may emit extra states; the frontend normalizes to this union.
 */
export const AgentStatusSchema = z.enum(['ACTIVE', 'IDLE', 'OFFLINE']);

/**
 * Agent identifier — lowercase slug with optional numeric suffix (e.g. `nova`, `nova-2`).
 */
export const AgentIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}(-\d+)?$/);

/**
 * Task identifier — UUID v4 string emitted by the gateway.
 */
export const TaskIdSchema = z.string().uuid();

/**
 * AgentRegisterSchema — payload for mcp__cortex__agent_register / POST /api/agents.
 * `name` is the human-readable label; `agent_id` is the slug used for routing.
 */
export const AgentRegisterSchema = z.object({
  agent_id: AgentIdSchema,
  name: z.string().min(1).max(120).optional(),
  capabilities: z.array(z.string()).max(64).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * HeartbeatSchema — liveness ping from a running agent.
 */
export const HeartbeatSchema = z.object({
  agent_id: AgentIdSchema.optional(),
  status: AgentStatusSchema.optional(),
  current_task_id: z.string().uuid().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * GetNextTaskSchema — no required arguments, but accepts optional filters.
 */
export const GetNextTaskSchema = z.object({
  project_id: z.string().uuid().optional(),
  phase_number: z.number().int().positive().optional(),
});
