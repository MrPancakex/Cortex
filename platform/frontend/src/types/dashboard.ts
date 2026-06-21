import { z } from 'zod';
import { AgentStatusSchema } from '../../../../shared/schemas/agent.js';
/**
 * Canonical task lifecycle status union — re-exported from the ONE type
 * source, shared/constants.d.ts (a concrete union, not z.infer: the Vite
 * bundler can't follow the Zod runtime chain from a .js across the package
 * boundary). That union is pinned to core/schemas/task.js TaskStatusSchema by
 * the S6 contract test, and the runtime TASK_STATUSES derives from the same
 * schema — so there is exactly one source of truth.
 */
import type { TaskStatus } from '../../../../shared/constants.js';
export type { TaskStatus };

/** Canonical agent status union (derived from the shared zod enum). */
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/**
 * Every task action the dashboard can dispatch — mirrors the keys on
 * `DashboardActions`. Used by the Accordion status dropdown and by any
 * audit / telemetry surface that needs to enumerate the possible writes.
 */
export type TaskAction =
  | 'create'
  | 'claim'
  | 'release'
  | 'resume'
  | 'progress'
  | 'submit'
  | 'requestVerification'
  | 'approve'
  | 'reject'
  | 'reopen'
  | 'reassign'
  | 'cancel'
  | 'fail'
  | 'delete'
  | 'comment'
  | 'update'
  | 'approveDelete'
  | 'denyDelete';

// === Branded nominal identifiers (Task 9.13) ===================================
// TypeScript erases brands at runtime; they exist purely to stop accidental
// cross-substitution of (say) an AgentId where a TaskId was required.
declare const agentIdBrand: unique symbol;
declare const taskIdBrand: unique symbol;
declare const projectIdBrand: unique symbol;

export type AgentId = string & { readonly [agentIdBrand]: true };
export type TaskId = string & { readonly [taskIdBrand]: true };
export type ProjectId = string & { readonly [projectIdBrand]: true };

export const asAgentId = (s: string): AgentId => s as AgentId;
export const asTaskId = (s: string): TaskId => s as TaskId;
export const asProjectId = (s: string): ProjectId => s as ProjectId;

// === Actions contract ===
// Shape of the `actions` bundle returned by useApi/useSimulation. Kept loose
// (functions rather than a zod schema) because the frontend never serializes
// it — only invokes it.
export interface DashboardActions {
  createTask: (input: {
    title: string;
    description: string;
    project_id: string;
    phase_number: number;
    section?: string;
    node?: string;
    reviewer?: string;
    priority?: string;
  }) => Promise<any>;
  claimTask: (taskId: string) => Promise<any>;
  resumeTask: (taskId: string) => Promise<any>;
  submitTask: (taskId: string, result?: string) => Promise<any>;
  requestVerification: (taskId: string, reviewer: string) => Promise<any>;
  approveTask: (taskId: string) => Promise<any>;
  rejectTask: (taskId: string, reason: string) => Promise<any>;
  releaseTask: (taskId: string) => Promise<any>;
  reassignTask: (taskId: string, agent: string) => Promise<any>;
  reopenTask: (taskId: string, reason?: string) => Promise<any>;
  cancelTask: (taskId: string, reason?: string) => Promise<any>;
  failTask: (taskId: string, reason?: string) => Promise<any>;
  deleteTask: (taskId: string) => Promise<any>;
  createProject: (name: string, description: string, defaultReviewer?: string) => Promise<any>;
  deleteProject: (projectId: string) => Promise<any>;
  completeProject: (projectId: string) => Promise<any>;
  addPhase: (projectId: string) => Promise<any>;
  deletePhase: (projectId: string, phaseNumber: number) => Promise<any>;
  createSection?: (projectId: string, phaseNumber: number, sectionName: string) => Promise<any>;
  approveDelete: (taskId: string) => Promise<any>;
  denyDelete: (taskId: string) => Promise<any>;
  approveAllDelete: () => Promise<any>;
  denyAllDelete: () => Promise<any>;
  sendMessage: (to: string, subject: string, body: string, taskId?: string) => Promise<any>;
  replyMessage: (messageId: string, body: string) => Promise<any>;
  updateTask?: (taskId: string, updates: Partial<TaskData>) => Promise<any>;
}

export interface DashboardData {
  overview: OverviewTopStrip;
  agents: AgentData[];
  projects: ProjectData[];
  bridgeMessages: BridgeMessageData[];
  activities: SystemLogData[];
  settingsSummary: SettingsRuntimeSummary;
  deleteRequests?: DeleteRequestData[];
  onNavigate?: (route: string) => void;
  actions?: DashboardActions | null;
}

export interface DeleteRequestData extends TaskData {
  delete_requested_at: number;
  delete_requested_by: string;
  project_name?: string;
}

export interface OverviewTopStrip {
  totalRequests: number;
  totalTokens: number;
  totalCost: number;
  avgLatency: number;
  errorRate: number;
}

export interface AgentData {
  name: string;
  model: string;
  platform: string;
  provider: string;
  status: AgentStatus;
  currentTask: string;
  lastHeartbeat: string;
  requestCount: number;
  latency: number;
  cost: number;
  errorCount: number;
  totalTokens?: number;
  stubRate?: number;
  accentColor?: string;
  requests?: AgentRequestData[];
  tasks?: TaskData[];
  phases?: PhaseData[];
}

export interface AgentRequestData {
  timestamp: string;
  method: string;
  model: string;
  tokens: number;
  cost: number;
  latency: number;
}

export interface PhaseData {
  phase_number: number;
  task_count: number;
  approved_count: number;
}

export interface ProjectData {
  id: string;
  name: string;
  status: string;
  progress: number;
  taskCount: number;
  completedCount: number;
  totalCost: number;
  tasks?: TaskData[];
  phases?: PhaseData[];
}

export interface TaskData {
  id: string;
  title: string;
  description?: string;
  assignedAgent: string;
  lifecycleStatus: TaskStatus;
  phase: number;
  section?: string;
  reviewer?: string;
  tokens?: number;
  cost?: number;
  updatedTime: string;
}

export interface BridgeMessageData {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  messageType: string;
  taskReference?: string;
  sentTime: string;
  readState: 'read' | 'unread';
}

export interface SystemLogData {
  id: string;
  timestamp: string;
  source: string;
  eventType: string;
  message: string;
  model?: string;
  latency?: number;
  tokens?: number;
  statusCode?: string;
  errorState?: boolean;
}

export interface SettingsRuntimeSummary {
  gatewayStatus: string;
  providerCount: number;
  registeredAgents: number;
  degradedReason?: string;
}

export interface SubAgentData {
  id: string;
  parentAgent: string;
  type: string;
  runtime: string;
  description: string;
  status: 'active' | 'completed' | 'failed';
  taskReference: string;
  duration: string;
  toolCalls?: number;
  model?: string;
  provider?: string;
}
