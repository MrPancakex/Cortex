import { useState, useEffect } from 'react';
import { DashboardData, AgentData, ProjectData, TaskData, BridgeMessageData, SystemLogData } from '../types/dashboard';

const EMPTY: DashboardData = {
  overview: { totalRequests: 0, totalTokens: 0, totalCost: 0, avgLatency: 0, errorRate: 0 },
  agents: [],
  sidecars: [],
  projects: [],
  bridgeMessages: [],
  activities: [],
  settingsSummary: { gatewayStatus: 'OFFLINE', providerCount: 0, registeredAgents: 0, sidecarStatuses: {} },
  actions: null,
};

const AGENT_COLORS: Record<string, string> = {
  atlas: 'purple',
  gerald: 'cyan',
  zeus: 'amber',
  faust: 'green',
};

// === API action helpers ===

async function apiPost(path: string, body?: any) {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
}

async function apiDelete(path: string) {
  const res = await fetch(`/api${path}`, { method: 'DELETE' });
  return res.json();
}

// === Data mapping functions ===

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
      status: (a.status || 'idle').toUpperCase(),
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
  return {
    id: String(t.id),
    title: t.title || t.description?.substring(0, 60) || 'Untitled',
    assignedAgent: t.assigned_agent || t.assignedAgent || '',
    lifecycleStatus: (t.status || 'pending').toUpperCase(),
    phase: t.phase_number || 0,
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

    const completed = projectTasks.filter((t: TaskData) => t.lifecycleStatus === 'APPROVED').length;

    return {
      id: String(p.id),
      name: p.name || p.slug || 'Unnamed',
      status: p.status === 'complete' || p.finished ? 'COMPLETE' : 'IN_PROGRESS',
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

// === Main hook ===

export function useApi(): DashboardData {
  const [data, setData] = useState<DashboardData>(EMPTY);

  // Action handlers — these call the backend proxy which forwards to the gateway
  const actions = {
    // Tasks
    createTask: async (title: string, description: string, projectId: string, phaseNumber: number) => {
      return apiPost('/tasks', { title, description, project_id: projectId, phase_number: phaseNumber });
    },
    claimTask: async (taskId: string) => {
      return apiPost(`/tasks/${taskId}/claim`);
    },
    submitTask: async (taskId: string, result?: string) => {
      return apiPost(`/tasks/${taskId}/submit`, result ? { result } : undefined);
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
    addPhase: async (projectId: string) => {
      return apiPost(`/projects/${projectId}/phases`);
    },
    deletePhase: async (projectId: string, phaseNumber: number) => {
      return apiDelete(`/projects/${projectId}/phases/${phaseNumber}`);
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
  };

  useEffect(() => {
    let mounted = true;

    const fetchSnapshot = async () => {
      try {
        const [snapRes, delRes] = await Promise.all([
          fetch('/api/tactical/snapshot'),
          fetch('/api/tasks/delete-requests')
        ]);

        if (!snapRes.ok) throw new Error('API degraded');
        const snap = await snapRes.json();
        const delData = delRes.ok ? await delRes.json() : { requests: [] };

        if (!mounted) return;
        if (snap.error === 'gateway_offline') {
          setData(prev => ({
            ...prev,
            actions,
            deleteRequests: delData.requests || [],
            settingsSummary: {
              ...prev.settingsSummary,
              gatewayStatus: 'OFFLINE',
              degradedReason: 'Gateway unreachable'
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
          sidecars: [],
          projects,
          bridgeMessages,
          activities,
          deleteRequests: delData.requests || [],
          actions,
          settingsSummary: {
            gatewayStatus: snap.health?.status === 'ok' ? 'ONLINE' : 'DEGRADED',
            providerCount: Object.keys(stats.requests_by_provider || {}).length,
            registeredAgents: agents.length,
            sidecarStatuses: {},
            degradedReason: snap.health?.status !== 'ok' ? 'Gateway health check failed' : undefined,
          }
        });
      } catch (err) {
        if (mounted) {
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
      }
    };

    fetchSnapshot();
    const interval = setInterval(fetchSnapshot, 2000);
    return () => { mounted = false; clearInterval(interval); };
  }, []);

  return data;
}
