// TypeScript shim for shared/schemas/agent.js. Phase 3 will replace this
// with a full .ts source (and a broader index.ts barrel); Phase 9 only
// needs the enum + id schemas plus their derived types.
import { z } from 'zod';

// Zod v4's z.enum(values) infers an enum-map type whose `z.infer` is the
// *value union* (keyof enumMap). We model that directly so consumers can
// `z.infer<typeof AgentStatusSchema>` and get 'ACTIVE' | 'IDLE' | 'OFFLINE'.
type AgentStatusEnum = { readonly ACTIVE: 'ACTIVE'; readonly IDLE: 'IDLE'; readonly OFFLINE: 'OFFLINE' };

export const AgentStatusSchema: z.ZodEnum<AgentStatusEnum>;
export const AgentIdSchema: z.ZodString;
export const TaskIdSchema: z.ZodString;
