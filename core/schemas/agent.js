// Agent-domain schemas consumed by both the gateway (Phase 3 contract layer)
// and the dashboard frontend (Phase 9 typed fetch layer).
//
// The three originals (AgentStatusSchema, AgentIdSchema, TaskIdSchema) are
// preserved verbatim for Phase 9 compatibility. Phase 3 adds the broader
// agent-register / agent-status / heartbeat schemas used at MCP and HTTP
// trust boundaries.
//
// Phase 1 — lifted verbatim from shared/schemas/agent.js. The full Agent
// row shape (with registered_at, last_heartbeat, etc.) lands in Phase 6.
//
// AgentIdSchema and TaskIdSchema are the canonical definitions; they live in
// _primitives.js and are re-exported from here so existing consumers that
// import from agent.js keep working without any import path changes.
import { z } from 'zod';
import { AgentIdSchema, TaskIdSchema } from './_primitives.js';
// Re-export so existing consumers that import from agent.js keep working.
export { AgentIdSchema, TaskIdSchema };

/**
 * Agent runtime status as surfaced to the dashboard.
 * The gateway may emit extra states; the frontend normalizes to this union.
 */
export const AgentStatusSchema = z.enum(['ACTIVE', 'IDLE', 'OFFLINE']);

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
