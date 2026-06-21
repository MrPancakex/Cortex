/**
 * core/types/api.ts — Backend-derived TypeScript types.
 *
 * All types are z.infer derivations from runtime Zod schemas in
 * core/schemas/. Do not hand-write shapes here; edit the schema instead
 * and the type updates automatically.
 *
 * Re-exports all types from the per-domain .d.ts files, plus adds:
 *  - Task-lifecycle derived aliases that weren't present in task.d.ts
 *  - BridgeMessage (the persisted row shape)
 *  - ListResponse<T> helper for paginated API responses
 */
import type { z } from 'zod';
import type {
  TaskStatusSchema,
  TaskPrioritySchema,
  TaskCreateSchema,
  TaskUpdateSchema,
  TaskCancelSchema,
  TaskReleaseSchema,
  TaskReassignSchema,
  TaskReopenSchema,
  TaskCommentSchema,
  SubmitResultSchemaV2,
  RequestVerificationSchema,
  RequestVerificationSchemaV2,
  TaskClaimOrphanSchema,
  JournalEntryTypeSchema,
  JournalEntrySchema,
  JournalAppendSchema,
  JournalQuerySchema,
} from '../schemas/task.js';
import type {
  BridgeSendSchema,
  BridgeInboxSchema,
  BridgeTypeSchema,
  BridgeDeliveryStateSchema,
  BridgeMessageSchema,
} from '../schemas/bridge.js';
import type {
  AgentStatusSchema,
  AgentIdSchema,
  AgentRegisterSchema,
  HeartbeatSchema,
  GetNextTaskSchema,
} from '../schemas/agent.js';
import type {
  ProgressStatusSchema,
  ProgressReportSchema,
} from '../schemas/progress.js';

// ---- Task types ---------------------------------------------------------------

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;
export type TaskCreate = z.infer<typeof TaskCreateSchema>;
export type TaskUpdate = z.infer<typeof TaskUpdateSchema>;
export type TaskCancel = z.infer<typeof TaskCancelSchema>;
export type TaskRelease = z.infer<typeof TaskReleaseSchema>;
export type TaskReassign = z.infer<typeof TaskReassignSchema>;
export type TaskReopen = z.infer<typeof TaskReopenSchema>;
export type TaskComment = z.infer<typeof TaskCommentSchema>;
export type SubmitResultV2 = z.infer<typeof SubmitResultSchemaV2>;
export type RequestVerification = z.infer<typeof RequestVerificationSchema>;
export type RequestVerificationV2 = z.infer<typeof RequestVerificationSchemaV2>;
export type TaskClaimOrphan = z.infer<typeof TaskClaimOrphanSchema>;

// ---- Journal types ------------------------------------------------------------

export type JournalEntryType = z.infer<typeof JournalEntryTypeSchema>;
export type JournalEntry = z.infer<typeof JournalEntrySchema>;
export type JournalAppend = z.infer<typeof JournalAppendSchema>;
export type JournalQuery = z.infer<typeof JournalQuerySchema>;

// ---- Bridge types -------------------------------------------------------------

export type BridgeSend = z.infer<typeof BridgeSendSchema>;
export type BridgeInbox = z.infer<typeof BridgeInboxSchema>;
export type BridgeKind = BridgeSend['kind'];
export type BridgeType = z.infer<typeof BridgeTypeSchema>;
export type BridgeDeliveryState = z.infer<typeof BridgeDeliveryStateSchema>;
export type BridgeMessage = z.infer<typeof BridgeMessageSchema>;

// ---- Agent types --------------------------------------------------------------

export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type AgentId = z.infer<typeof AgentIdSchema>;
export type AgentRegister = z.infer<typeof AgentRegisterSchema>;
export type Heartbeat = z.infer<typeof HeartbeatSchema>;
export type GetNextTask = z.infer<typeof GetNextTaskSchema>;

// ---- Progress types ----------------------------------------------------------

export type ProgressStatus = z.infer<typeof ProgressStatusSchema>;
export type ProgressReport = z.infer<typeof ProgressReportSchema>;

// ---- API response helpers ----------------------------------------------------

/**
 * Generic paginated list response. `items` is the collection field name;
 * callers pick a concrete alias (e.g. TaskListResponse = ListResponse<TaskCreate>)
 * based on their payload shape.
 *
 * The `tasks` field name matches the gateway's `/v1/api/tasks` response
 * envelope used by the dashboard.
 */
export type ListResponse<T> = {
  tasks: T[];
  total: number;
  __schema_version: string;
};
