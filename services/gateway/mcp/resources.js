export function getResources() {
  return [
    {
      uri: 'cortex://status',
      name: 'System Status',
      description: 'Current Cortex system status -- services, bots, uptime',
      mimeType: 'text/plain',
    },
    {
      uri: 'cortex://agents',
      name: 'Agent Registry',
      description: 'All registered bots with status and daily metrics',
      mimeType: 'text/plain',
    },
    {
      uri: 'cortex://tasks/active',
      name: 'Active Tasks',
      description: 'All currently active agent tasks',
      mimeType: 'text/plain',
    },
    {
      uri: 'cortex://bridge/recent',
      name: 'Recent Bridge Messages',
      description: 'Last 20 inter-agent messages',
      mimeType: 'text/plain',
    },
    {
      uri: 'cortex://metrics/today',
      name: 'Daily Metrics',
      description: 'Token usage, cost, request counts for today',
      mimeType: 'text/plain',
    },
    {
      uri: 'cortex://config',
      name: 'Configuration',
      description: 'Current Cortex configuration (sanitised -- no secrets)',
      mimeType: 'text/plain',
    },
  ];
}

async function gatewayJson(gateway, path) {
  const headers = { 'content-type': 'application/json' };
  if (gateway.config.agentToken) {
    headers['x-cortex-token'] = gateway.config.agentToken;
  }
  const response = await fetch(`${gateway.config.gatewayUrl}${path}`, { headers });
  if (!response.ok) throw new Error(`${path} -> ${response.status}`);
  return response.json();
}

export async function readResource(uri, gateway) {
  switch (uri) {
    case 'cortex://status': {
      const data = await gatewayJson(gateway, '/api/health');
      const uptime = data.uptime || Math.floor(process.uptime());
      const lines = [
        `Cortex Gateway -- uptime: ${uptime}s`,
        `Timestamp: ${new Date().toISOString()}`,
        `Status: ${data.status || 'ok'}`,
      ];
      return lines.join('\n');
    }

    case 'cortex://agents': {
      const data = await gatewayJson(gateway, '/api/agents');
      const agents = Array.isArray(data.agents) ? data.agents : data.agents ? [data.agents] : [];
      if (!agents.length) return 'No agents registered.';
      const lines = agents.map(a => [
        `Agent: ${a.name || a.id} (${a.id})`,
        `  Model: ${a.model || '-'} | Provider: ${a.provider || '-'}`,
        `  Status: ${a.status || 'unknown'} | Last active: ${a.last_active || 'never'}`,
        a.today ? `  Today: ${a.today.requests || 0} requests | in=${a.today.tokens_in || 0} out=${a.today.tokens_out || 0} | cost=$${(a.today.cost || 0).toFixed(4)} | errors=${a.today.errors || 0}` : '',
      ].filter(Boolean).join('\n'));
      return lines.join('\n\n');
    }

    case 'cortex://tasks/active': {
      const data = await gatewayJson(gateway, '/api/tasks?status=claimed&limit=50');
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      if (!tasks.length) return 'No active tasks.';
      return tasks.map(t =>
        `[${t.id}] ${t.title || '-'} -- agent=${t.assigned_agent || 'unassigned'} priority=${t.priority || '-'}`
      ).join('\n');
    }

    case 'cortex://bridge/recent': {
      const data = await gatewayJson(gateway, `/api/bridge/inbox/${encodeURIComponent(gateway.config.agentId)}?limit=20`);
      const msgs = Array.isArray(data.messages) ? data.messages : [];
      if (!msgs.length) return 'No bridge messages.';
      return msgs.map(m =>
        `[${m.sent_at || m.created_at}] ${m.from_agent} -> ${m.to_agent} (${m.type || 'message'}) ${m.read ? '[read]' : '[unread]'}\n  ${String(m.content || m.body || '').slice(0, 100)}`
      ).join('\n\n');
    }

    case 'cortex://metrics/today': {
      const data = await gatewayJson(gateway, `/api/costs/${encodeURIComponent(gateway.config.agentId)}?period=today`);
      if (!data || (!data.requests && !data.cost)) return 'No model calls today.';
      const lines = [
        'Daily metrics (today):',
        `  Requests: ${data.requests || 0}`,
        `  Tokens in: ${data.tokens_in || 0} | out: ${data.tokens_out || 0}`,
        `  Cost: $${(data.cost || 0).toFixed(4)}`,
        `  Errors: ${data.errors || 0}`,
      ];
      return lines.join('\n');
    }

    case 'cortex://config': {
      const cfg = gateway.config || {};
      const safe = { ...cfg };
      for (const key of Object.keys(safe)) {
        if (/key|token|secret|password|auth/i.test(key)) safe[key] = '[redacted]';
      }
      return JSON.stringify(safe, null, 2);
    }

    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
}
