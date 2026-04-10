export interface DashboardData {
  overview: OverviewTopStrip;
  agents: AgentData[];
  sidecars: SidecarData[];
  projects: ProjectData[];
  bridgeMessages: BridgeMessageData[];
  activities: SystemLogData[];
  settingsSummary: SettingsRuntimeSummary;
  deleteRequests?: DeleteRequestData[];
  onNavigate?: (route: string) => void;
  actions?: any;
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
  status: string;
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
  phases?: any[];
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

export interface SidecarData {
  name: string;
  role: string;
  status: string;
  serviceName: string;
  processedCount: number;
  throughput: number;
  avgProcessTime: number;
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
  assignedAgent: string;
  lifecycleStatus: string;
  phase: number;
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
  sidecarStatuses: Record<string, string>;
  degradedReason?: string;
}

export interface SubAgentData {
  id: string;
  parentAgent: string;
  type: string;
  description: string;
  status: 'active' | 'completed' | 'failed';
  taskReference: string;
  duration: string;
  toolCalls?: number;
}
