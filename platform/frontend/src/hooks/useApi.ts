import { useState, useEffect } from 'react';
import { DashboardData, AgentData, ProjectData, TaskData, BridgeMessageData, SystemLogData, TaskStatus } from '../types/dashboard';
import { TASK_STATUSES } from '../../../../shared/constants.js';

const EMPTY: DashboardData = {
  overview: { totalRequests: 0, totalTokens: 0, totalCost: 0, avgLatency: 0, errorRate: 0 },
  agents: [],
  projects: [],
  bridgeMessages: [],
  activities: [],
  settingsSummary: { gatewayStatus: 'OFFLINE', providerCount: 0, registeredAgents: 0 },
  actions: null,
};

// UI accent palette per agent. Not a registry — the backend's token-registry
// is the source of truth for *which* agents exist; this map only colors the
// four first-class Cortex agents so their cards visually disambiguate in the
// dashboard. Any unmapped agent falls back to 'purple' below (mapAgents).
// Update policy: when a new first-class agent is added to the Cortex core
// (not a one-off user agent), add its color here alongside the shared/
// registry bump.
const AGENT_COLORS: Record<string, string> = {
  nova: 'purple',
  orion: 'cyan',
  scout: 'amber',
  pioneer: 'green',
};

/**
 * Frontend-local ok-checking wrapper.
 *
 * WHY NOT sdk/http/client.js: `@cortex/sdk` is a Node-only workspace package
 * (it imports Node built-ins and workspace deps that Vite cannot bundle).
 * The canonical Node-side home is `sdk/http/client.js gatewayFetch`; this
 * function is the browser-side equivalent — same !ok → typed rejection
 * contract, minimal surface, no Node deps.
 */
async function apiFetch(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`/api${path}`, init);
  let parsed: any;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const message: string = parsed?.error || parsed?.message || `${res.status} ${res.statusText}`;
    const err: any = new Error(message);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

async function apiPost(path: string, body?: any, signal?: AbortSignal) {
  return apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
}

async function apiDelete(path: string) {
  return apiFetch(path, { method: 'DELETE' });
}

async function apiPatch(path: string, body: any) {
  return apiFetch(path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Normalize the gateway's agent status string to the frontend canonical
 * vocabulary of `ACTIVE | IDLE | OFFLINE`. Anything unrecognized collapses
 * to OFFLINE so healthy-status checks don't accidentally count it.
 */
function normalizeAgentStatus(raw: any): 'ACTIVE' | 'IDLE' | 'OFFLINE' {
  const s = String(raw || '').toLowerCase();
  if (s === 'active' || s === 'online' || s === 'busy' || s === 'working') return 'ACTIVE';
  if (s === 'idle' || s === 'ready' || s === 'available') return 'IDLE';
  return 'OFFLINE';
}

/** Predicate for the "agent is reachable" UI indicator. */
export function isAgentHealthy(status: string): boolean {
  return status === 'ACTIVE' || status === 'IDLE';
}

function mapAgents(raw: any, stats: any): AgentData[] {
  const agents = (raw?.agents || []).filter((a: any) => (a.agent_id || a.name || a.id) !== "admin");
  if (!Array.isArray(agents)) return [];

  const byAgent = stats?.requests_by_agent || {};

  return agents.map((a: any) => {
    const name = a.agent_id || a.name || a.id || 'unknown';
    const agentStats = byAgent[name.toLowerCase()] || {};
    return {
      name: name.charAt(0).toUpperCase() + name.slice(1),
      model: a.model || a.platform || 'unknown',
      platform: a.platform || '',
      provider: a.provider || '',
      status: normalizeAgentStatus(a.status),
      currentTask: (typeof a.current_task === 'object' && a.current_task?.id) ? a.current_task.id : (a.current_task || a.currentTask || 'No active task'),
      lastHeartbeat: a.last_heartbeat || a.lastHeartbeat || 'unknown',
      requestCount: agentStats.count || a.request_count || 0,
      latency: agentStats.avg_latency || a.latency || 0,
      cost: agentStats.cost || a.cost || 0,
      errorCount: agentStats.errors || a.error_count || 0,
      totalTokens: agentStats.tokens || a.total_tokens || 0,
      stubRate: a.stub_rate || 0,
      accentColor: AGENT_COLORS[name.toLowerCase()] || 'purple',
      requests: [],
      tasks: [],
    };
  });
}

function mapSingleTask(t: any): TaskData {
  const status = String(t.status || 'pending').toLowerCase();
  // Typecheck: restrict to the TaskStatus union if it is one, otherwise fall
  // back to 'pending' so a corrupted upstream payload can't brick the UI.
  const lifecycleStatus = (TASK_STATUSES as readonly string[]).includes(status)
    ? (status as TaskStatus)
    : 'pending';
  return {
    id: String(t.id),
    title: t.title || t.description?.substring(0, 60) || 'Untitled',
    description: t.description || '',
    assignedAgent: t.assigned_agent || t.assignedAgent || '',
    lifecycleStatus,
    phase: t.phase_number || 0,
    section: t.section || undefined,
    reviewer: t.reviewer || undefined,
    tokens: t.tokens || 0,
    cost: t.cost || 0,
    updatedTime: t.updated_at || t.created_at || '',
  };
}

function mapTasks(raw: any): TaskData[] {
  const tasks = raw?.tasks;
  if (!Array.isArray(tasks)) return [];
  return tasks.map(mapSingleTask);
}

function mapProjects(raw: any, allTasks: TaskData[]): ProjectData[] {
  const projects = raw?.projects || raw;
  if (!Array.isArray(projects)) return [];

  return projects.map((p: any) => {
    const projectTasks = Array.isArray(p.tasks)
      ? p.tasks.map((t: any) => mapSingleTask(t))
      : allTasks.filter((t: TaskData) => (t as any).project_id === p.id);

    const completed = projectTasks.filter((t: TaskData) => t.lifecycleStatus === 'approved').length;

    return {
      id: String(p.id),
      name: p.name || p.slug || 'Unnamed',
      status: p.status || 'active',
      progress: (p.task_count || projectTasks.length) > 0
        ? Math.round(((p.completed_count || completed) / (p.task_count || projectTasks.length)) * 100)
        : 0,
      taskCount: p.task_count || projectTasks.length,
      completedCount: p.completed_count || completed,
      totalCost: p.total_cost_usd || p.total_cost || 0,
      tasks: projectTasks,
      phases: Array.isArray(p.phases) ? p.phases : [],
    };
  });
}

function mapBridge(raw: any): BridgeMessageData[] {
  const messages = raw?.messages || raw;
  if (!Array.isArray(messages)) return [];

  return messages.map((m: any) => ({
    id: String(m.message_id || m.id),
    from: m.from_agent || m.from || '',
    to: m.to_agent || m.to || '',
    subject: m.subject || m.message_type || m.type || '',
    body: m.body || m.content || m.payload || '',
    messageType: m.message_type || m.type || 'message',
    taskReference: m.task_id || m.reference_task_id || undefined,
    sentTime: m.sent_at || m.created_at || m.timestamp || '',
    readState: m.acknowledged_at ? 'read' as const : 'unread' as const,
  }));
}

function mapLogs(raw: any): SystemLogData[] {
  const logs = raw?.logs || raw;
  if (!Array.isArray(logs)) return [];

  return logs.slice(0, 100).map((l: any, i: number) => ({
    id: String(l.id || i),
    timestamp: l.timestamp || l.created_at || '',
    source: l.agent_id || l.agent || l.source || 'system',
    eventType: l.method || l.event_type || 'REQ',
    message: l.path || l.message || '',
    model: l.model || undefined,
    latency: l.latency_ms || l.latency || undefined,
    tokens: (l.tokens_in || 0) + (l.tokens_out || 0) || undefined,
    statusCode: l.status_code ? String(l.status_code) : undefined,
    errorState: l.error ? true : (l.status_code >= 400),
  }));
}

export interface CreateTaskInput {
  title: string;
  description: string;
  project_id: string;
  phase_number: number;
  section?: string;
  node?: string;
  reviewer?: string;
  priority?: string;
}

export function useApi(): DashboardData {
  const [data, setData] = useState<DashboardData>(EMPTY);

  // Action handlers — these call the backend proxy which forwards to the gateway
  const actions = {
    // Tasks
    createTask: async (input: CreateTaskInput) => {
      // F10 — backend `task_create` policy (routes/cortex-tasks.js:625) forces
      // assignedAgent=null and never reads reviewer_agent. Forwarding either
      // field would have it silently dropped. Drop them at the boundary so
      // the request payload reflects what actually persists. The form may
      // still capture node/reviewer for future use; today they're inert.
      const { title, description, project_id, phase_number, section, priority } = input;
      return apiPost('/tasks', {
        title,
        description,
        project_id,
        phase_number,
        ...(section ? { section } : {}),
        ...(priority ? { priority } : {}),
      });
    },
    claimTask: async (taskId: string) => {
      return apiPost(`/tasks/${taskId}/claim`);
    },
    resumeTask: async (taskId: string) => {
      // F9 — /resume fans out by current task status: pending→claim,
      // claimed→resumeFromClaim, rejected→resumeFromReject. The previous
      // implementation always called /claim, which silently no-op'd for
      // any status other than 'pending'.
      return apiPost(`/tasks/${taskId}/resume`);
    },
    submitTask: async (taskId: string, result?: string) => {
      return apiPost(`/tasks/${taskId}/submit`, result ? { result } : undefined);
    },
    requestVerification: async (taskId: string, reviewer: string) => {
      // F8 — reviewer is required at the backend (RequestVerificationSchema +
      // tools.js:84). The TS signature now reflects that contract; missing
      // reviewer becomes a local TypeScript error instead of a 400 round-trip.
      if (!reviewer) throw new Error('requestVerification requires a reviewer');
      return apiPost(`/tasks/${taskId}/request-review`, { reviewer });
    },
    approveTask: async (taskId: string) => {
      return apiPost(`/tasks/${taskId}/approve`);
    },
    rejectTask: async (taskId: string, reason: string) => {
      return apiPost(`/tasks/${taskId}/reject`, { reason });
    },
    releaseTask: async (taskId: string) => {
      return apiPost(`/tasks/${taskId}/release`);
    },
    reassignTask: async (taskId: string, agent: string) => {
      return apiPost(`/tasks/${taskId}/reassign`, { new_agent: agent });
    },
    reopenTask: async (taskId: string, reason?: string) => {
      return apiPost(`/tasks/${taskId}/reopen`, { reason: reason || 'Reopened from dashboard' });
    },
    cancelTask: async (taskId: string, reason?: string) => {
      return apiPost(`/tasks/${taskId}/cancel`, { reason: reason || 'Cancelled from dashboard' });
    },
    failTask: async (taskId: string, reason?: string) => {
      return apiPost(`/tasks/${taskId}/fail`, { reason: reason || 'Failed from dashboard' });
    },
    deleteTask: async (taskId: string) => {
      return apiDelete(`/tasks/${taskId}`);
    },

    // Projects
    createProject: async (name: string, description: string, defaultReviewer?: string) => {
      return apiPost('/projects', { name, description, ...(defaultReviewer ? { default_reviewer: defaultReviewer } : {}) });
    },
    deleteProject: async (projectId: string) => {
      return apiDelete(`/projects/${projectId}`);
    },
    completeProject: async (projectId: string) => {
      return apiPatch(`/projects/${projectId}`, { status: 'completed' });
    },
    addPhase: async (projectId: string) => {
      return apiPost(`/projects/${projectId}/phases`);
    },
    deletePhase: async (projectId: string, phaseNumber: number) => {
      return apiDelete(`/projects/${projectId}/phases/${phaseNumber}`);
    },
    createSection: async (projectId: string, phaseNumber: number, sectionName: string) => {
      // Stub for backend bot to tie in
      return apiPost(`/projects/${projectId}/phases/${phaseNumber}/sections`, { name: sectionName });
    },

    // Task Delete Requests
    approveDelete: async (taskId: string) => {
      return apiPost(`/tasks/${taskId}/approve-delete`);
    },
    denyDelete: async (taskId: string) => {
      return apiPost(`/tasks/${taskId}/deny-delete`);
    },
    approveAllDelete: async () => {
      return apiPost('/tasks/delete-requests/approve-all');
    },
    denyAllDelete: async () => {
      return apiPost('/tasks/delete-requests/deny-all');
    },

    // Bridge
    sendMessage: async (to: string, subject: string, body: string, taskId?: string) => {
      return apiPost('/bridge/send', { to, subject, body, task_id: taskId });
    },
    replyMessage: async (messageId: string, body: string) => {
      return apiPost(`/bridge/reply/${messageId}`, { body });
    },
    updateTask: async (taskId: string, updates: Partial<TaskData>) => {
      // Stub for backend bot to tie in
      return apiPatch(`/tasks/${taskId}`, updates);
    },
  };

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    const fetchSnapshot = async () => {
      try {
        const [snapRes, delRes] = await Promise.all([
          fetch('/api/tactical/snapshot', { signal: controller.signal }),
          fetch('/api/tasks/delete-requests', { signal: controller.signal })
        ]);

        if (cancelled) return;
        if (!snapRes.ok) throw new Error('API degraded');
        const snap = await snapRes.json();
        const delData = delRes.ok ? await delRes.json() : { requests: [] };

        if (cancelled) return;
        // Degraded shape: the backend proxy may return either `{ error: '...' }`
        // at the top level or nested under a widget (see Task 9.10 / 9.11).
        const topLevelError = typeof snap?.error === 'string' ? snap.error : null;
        if (topLevelError) {
          const reason = topLevelError === 'gateway_offline' ? 'Gateway unreachable'
            : topLevelError === 'gateway_timeout' ? 'Gateway timed out'
            : topLevelError === 'gateway_unreachable' ? 'Gateway DNS/route failure'
            : `Upstream error: ${topLevelError}`;
          setData(prev => ({
            ...prev,
            actions,
            deleteRequests: delData.requests || [],
            settingsSummary: {
              ...prev.settingsSummary,
              gatewayStatus: 'OFFLINE',
              degradedReason: reason,
            }
          }));
          return;
        }

        const stats = snap.stats || {};
        const tasks = mapTasks(snap.tasks);
        const agents = mapAgents(snap.agents, stats);
        const projects = mapProjects(snap.projects, tasks);
        const bridgeMessages = mapBridge(snap.bridge);
        const activities = mapLogs(snap.logs);

        setData({
          overview: {
            totalRequests: stats.total_requests || 0,
            totalTokens: (stats.total_tokens_in || 0) + (stats.total_tokens_out || 0),
            totalCost: stats.total_cost_usd || 0,
            avgLatency: stats.avg_latency_ms || 0,
            errorRate: stats.error_rate || 0,
          },
          agents,
          projects,
          bridgeMessages,
          activities,
          deleteRequests: delData.requests || [],
          actions,
          settingsSummary: {
            gatewayStatus: snap.health?.status === 'ok' ? 'ONLINE' : 'DEGRADED',
            providerCount: Object.keys(stats.requests_by_provider || {}).length,
            registeredAgents: agents.length,
            degradedReason: snap.health?.status !== 'ok' ? 'Gateway health check failed' : undefined,
          }
        });
      } catch (err: any) {
        if (err?.name === 'AbortError' || cancelled) return;
        setData(prev => ({
          ...prev,
          actions,
          settingsSummary: {
            ...prev.settingsSummary,
            gatewayStatus: 'OFFLINE',
            degradedReason: 'Backend unreachable'
          }
        }));
      }
    };

    fetchSnapshot();
    const interval = setInterval(fetchSnapshot, 2000);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(interval);
    };
  }, []);

  return data;
}
