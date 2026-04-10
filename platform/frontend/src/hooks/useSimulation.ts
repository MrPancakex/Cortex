import { useState, useEffect } from 'react';
import { DashboardData } from '../types/dashboard';

export function useSimulation(): DashboardData {
  const [data, setData] = useState<DashboardData>({
    overview: {
      totalRequests: 14507,
      totalTokens: 520400,
      totalCost: 145.20,
      avgLatency: 840,
      errorRate: 0.02
    },
    agents: [
      { 
        name: 'Atlas', model: 'Opus 4.6', platform: 'claude-code', provider: 'Anthropic', status: 'ACTIVE', currentTask: 'Translating Core Logic', lastHeartbeat: '60ms ago', requestCount: 1860, latency: 428, cost: 24.80, errorCount: 1, stubRate: 0.015, totalTokens: 85200, 
        accentColor: 'green',
        requests: [
          { timestamp: '10:14:02 AM', method: 'Streaming', model: 'opus', tokens: 1840, cost: 0.45, latency: 380 },
          { timestamp: '10:13:45 AM', method: 'Standard', model: 'opus', tokens: 2011, cost: 0.52, latency: 410 },
          { timestamp: '10:11:10 AM', method: 'Streaming', model: 'opus', tokens: 504, cost: 0.12, latency: 320 }
        ], 
        tasks: [{ id: 't1', title: 'Compile Base Schema', assignedAgent: 'Atlas', lifecycleStatus: 'approved', phase: 'Phase 1', updatedTime: '1h ago', tokens: 4000, cost: 1.2, reviewer: 'HUMAN' }] 
      },
      { 
        name: 'Gerald', model: 'Sonnet 4.6', platform: 'hermes', provider: 'Anthropic', status: 'ACTIVE', currentTask: 'Drafting View Models', lastHeartbeat: '10ms ago', requestCount: 8475, latency: 180, cost: 18.50, errorCount: 0, stubRate: 0.0, totalTokens: 254000, 
        accentColor: 'cyan',
        requests: [
          { timestamp: '10:14:50 AM', method: 'Streaming', model: 'sonnet-3.5', tokens: 450, cost: 0.08, latency: 140 }
        ], 
        tasks: [] 
      },
      { name: 'Zeus', model: 'GPT-5.4', platform: 'codex', provider: 'OpenAI', status: 'IDLE', currentTask: 'Pending Assignment', lastHeartbeat: '2m ago', requestCount: 1200, latency: 450, cost: 0.00, errorCount: 0, stubRate: 0.0, totalTokens: 42000, accentColor: 'amber', requests: [], tasks: [] },
      { name: 'Faust', model: 'GPT-5.4', platform: 'hermes', provider: 'Hermes', status: 'ACTIVE', currentTask: 'Parsing Logs', lastHeartbeat: 'Offline', requestCount: 4500, latency: 200, cost: 5.40, errorCount: 45, stubRate: 1.2, totalTokens: 14000, accentColor: 'purple', requests: [], tasks: [] }
    ],
    sidecars: [
      { name: 'Bookkeeper', role: 'Context Store', status: 'ONLINE', serviceName: 'v-store-01', processedCount: 7638, throughput: 325, avgProcessTime: 12 },
      { name: 'Sentinel', role: 'Security Scanning', status: 'ONLINE', serviceName: 'q-relay-02', processedCount: 16072, throughput: 88, avgProcessTime: 8 },
      { name: 'Autopsy', role: 'Error Analysis', status: 'ONLINE', serviceName: 'sys-audit', processedCount: 3209, throughput: 42, avgProcessTime: 3 }
    ],
    projects: [
      {
        id: '1', name: 'Cortex V0.1', status: 'IN_PROGRESS', progress: 75, taskCount: 24, completedCount: 18, totalCost: 120.50,
        tasks: [
          { id: 't1', title: 'Setup UI Base', assignedAgent: 'Atlas', lifecycleStatus: 'APPROVED', phase: 'Phase 1', tokens: 45000, cost: 4.50, updatedTime: '1h ago' },
          { id: 't2', title: 'Write Tests', assignedAgent: 'Zeus', lifecycleStatus: 'IN_REVIEW', phase: 'Phase 2', reviewer: 'Human', tokens: 12000, cost: 0.80, updatedTime: '10m ago' }
        ]
      }
    ],
    bridgeMessages: [
      { id: '1', from: 'Atlas', to: 'Zeus', subject: 'Type Definition Verification', body: 'Please confirm the dashboard types file matches the backend interface.', messageType: 'TASK_SYNC', taskReference: 'PRJ-101-TASK-03', sentTime: '10:45 AM', readState: 'read' },
      { id: '2', from: 'System', to: 'Atlas', subject: 'Memory Limit Approaching', body: 'You are nearing token context threshold.', messageType: 'ALERT', sentTime: '10:48 AM', readState: 'unread' }
    ],
    activities: [
      { id: '1', timestamp: '10:45:01', source: 'Atlas', eventType: 'LLM_REQUEST', message: 'Generating component code', model: 'claude-3-opus-20240229', latency: 4500, tokens: 450, statusCode: '200', errorState: false },
      { id: '2', timestamp: '10:45:15', source: 'Gateway', eventType: 'PROXY_ROUTE', message: 'Traffic routed successfully', statusCode: '200', errorState: false },
      { id: '3', timestamp: '10:46:12', source: 'Faust', eventType: 'LLM_REQUEST', message: 'Context window exceeded', model: 'gpt-3.5-turbo', latency: 1500, tokens: 16000, statusCode: '400', errorState: true }
    ],
    settingsSummary: {
      gatewayStatus: 'ONLINE',
      providerCount: 3,
      registeredAgents: 4,
      sidecarStatuses: { 'cortex-bookkeeper': 'ONLINE', 'cortex-autopsy': 'DEGRADED' },
      degradedReason: 'High latency on OpenAI socket connection'
    }
  });

  useEffect(() => {
    // Just a tiny heartbeat pulse to prove reactivity
    const interval = setInterval(() => {
      setData(prev => ({
        ...prev,
        overview: {
          ...prev.overview,
          totalRequests: prev.overview.totalRequests + 1
        }
      }));
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  return data;
}
