import type { z } from 'zod';
import type {
  AgentStatusSchema,
  AgentIdSchema,
  TaskIdSchema,
  AgentRegisterSchema,
  HeartbeatSchema,
  GetNextTaskSchema,
} from '../schemas/agent.js';

export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type AgentId = z.infer<typeof AgentIdSchema>;
export type TaskId = z.infer<typeof TaskIdSchema>;
export type AgentRegister = z.infer<typeof AgentRegisterSchema>;
export type Heartbeat = z.infer<typeof HeartbeatSchema>;
export type GetNextTask = z.infer<typeof GetNextTaskSchema>;
