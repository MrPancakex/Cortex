import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { getStmts, genId, jsonParse } from '../lib/db.js';
import { broadcastLog } from '../lib/proxy.js';

function agentContext(gateway, args = {}) {
  const agentId = gateway.config.agentId;
  if (!agentId) throw new Error('agent_id not configured — set CORTEX_AGENT_ID');
  return {
    agentId,
    platform: gateway.config.agentPlatform || agentId,
  };
}

async function gatewayJson(gateway, path, init = {}) {
  // Attach X-Cortex-Token for authenticated task routes
  if (gateway.config.agentToken) {
    if (!init.headers) init.headers = {};
    // Merge with existing headers (don't overwrite content-type etc.)
    if (typeof init.headers === 'object' && !Array.isArray(init.headers)) {
      init.headers['x-cortex-token'] = gateway.config.agentToken;
    }
  }

  let response;
  try {
    response = await fetch(`${gateway.config.gatewayUrl}${path}`, init);
  } catch (err) {
    throw new Error(`Gateway unreachable: ${err.message}`);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    body = { error: `${response.status} ${response.statusText}` };
  }
  if (!response.ok) {
    throw new Error(body?.error || `${response.status} ${response.statusText}`);
  }
  return body;
}

async function syncCurrentTaskFile(gateway, taskId) {
  const taskFile = gateway.config.currentTaskFile;
  if (!taskFile) return { ok: false, skipped: true };

  const dir = path.dirname(taskFile);
  await mkdir(dir, { recursive: true });
  await writeFile(taskFile, `${taskId}\n`, 'utf8');
  return { ok: true, path: taskFile };
}

async function clearCurrentTaskFile(gateway, expectedTaskId = null) {
  const taskFile = gateway.config.currentTaskFile;
  if (!taskFile) return { ok: false, skipped: true };

  if (expectedTaskId) {
    try {
      const currentTaskId = (await readFile(taskFile, 'utf8')).trim();
      if (currentTaskId && currentTaskId !== expectedTaskId) {
        return { ok: false, skipped: true, current_task_id: currentTaskId };
      }
    } catch (err) {
      if (err?.code === 'ENOENT') return { ok: false, skipped: true, missing: true };
      throw err;
    }
  }

  await rm(taskFile, { force: true });
  return { ok: true, path: taskFile, cleared: true };
}

async function persistTaskState(gateway, response, action, taskId = null) {
  try {
    const localState = action === 'clear'
      ? await clearCurrentTaskFile(gateway, taskId)
      : await syncCurrentTaskFile(gateway, taskId);
    if (localState.ok) {
      response.local_state = {
        ...(response.local_state || {}),
        current_task_file: localState.path,
        action,
      };
    }
  } catch (err) {
    response.warning = `${response.warning ? `${response.warning}; ` : ''}failed to ${action} local current-task file: ${err.message}`;
  }

  return response;
}

// Tools that receive _inbox piggyback — only task-fetch tools where inbox context is useful
const INBOX_PIGGYBACK_TOOLS = new Set(['task_get', 'get_next_task', 'claim_task']);

let _inboxStmt = null;

function piggybackInbox(result, gateway, toolName) {
  if (!INBOX_PIGGYBACK_TOOLS.has(toolName)) return result;
  try {
    const agent = gateway.config.agentId;
    if (!agent) return result;
    // Lazy singleton — prepare once, reuse on every call
    if (!_inboxStmt) {
      _inboxStmt = gateway.db.prepare(
        `SELECT COUNT(*) as count, MAX(blocking) as has_blocking
         FROM bridge_messages
         WHERE to_agent = ? AND read = 0
         AND (expires_at IS NULL OR expires_at > unixepoch())`
      );
    }
    const row = _inboxStmt.get(agent) ?? { count: 0, has_blocking: 0 };
    const count = row.count ?? 0;
    if (count > 0) {
      return {
        _inbox: { count, has_blocking: row.has_blocking === 1 },
        ...result,
      };
    }
  } catch { /* piggyback is best-effort — don't break tool calls */ }
  return result;
}

export async function handleToolCall(name, args, gateway) {
  const start = Date.now();
  let result, error;
  try {
    result = await _dispatchTool(name, args, gateway);
  } catch (e) {
    error = e;
  }
  const latency = Date.now() - start;

  // Auto-telemetry: log every MCP tool call (success AND failure) for waterfall visibility
  const agent = gateway.config.agentId;
  if (agent) {
    try {
      await fetch(`${gateway.config.gatewayUrl}/api/gateway/telemetry`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(gateway.config.agentToken ? { 'x-cortex-token': gateway.config.agentToken } : {}),
        },
        body: JSON.stringify({
          method: `MCP:${name}`,
          endpoint: name,
          provider: 'mcp',
          model: gateway.config.agentPlatform || agent,
          project_id: args?.task_id || args?.project_id || null,
          status_code: error ? 500 : (result?.error ? 400 : 200),
          error: error?.message || result?.error || null,
          tokens_in: 0, tokens_out: 0, cost_usd: 0,
          latency_ms: latency,
        }),
      }).catch(() => {});
    } catch {}
  }

  // Rethrow if the tool call failed
  if (error) throw error;

  return piggybackInbox(result, gateway, name);
}

async function _dispatchTool(name, args, gateway) {
  switch (name) {
    case 'route_request':        return handleRouteRequest(args, gateway);
    case 'health_check':         return handleHealthCheck(_argsOrEmpty(args), gateway);
    case 'agent_status':         return handleAgentStatus(args, gateway);
    case 'task_get':             return handleTaskGet(args, gateway);
    case 'get_next_task':        return handleGetNextTask(args, gateway);
    case 'claim_task':           return handleClaimTask(args, gateway);
    case 'report_progress':      return handleReportProgress(args, gateway);
    case 'submit_result':        return handleSubmitResult(args, gateway);
    case 'request_verification': return handleRequestVerification(args, gateway);
    case 'task_approve':         return handleTaskApprove(args, gateway);
    case 'task_reject':          return handleTaskReject(args, gateway);
    case 'task_update':          return handleTaskUpdate(args, gateway);
    case 'task_cancel':          return handleTaskCancel(args, gateway);
    case 'heartbeat':            return handleHeartbeat(args, gateway);
    case 'agent_register':       return handleAgentRegister(args, gateway);
    case 'task_create':          return handleTaskCreate(args, gateway);
    case 'task_list':            return handleTaskList(args, gateway);
    case 'task_release':         return handleTaskRelease(args, gateway);
    case 'task_reassign':        return handleTaskReassign(args, gateway);
    case 'task_comment':         return handleTaskComment(args, gateway);
    case 'task_reopen':          return handleTaskReopen(args, gateway);
    case 'bridge_send':          return handleBridgeSend(args, gateway);
    case 'bridge_inbox':         return handleBridgeInbox(args, gateway);
    case 'bridge_poll':          return handleBridgePoll(args, gateway);
    case 'bridge_reply':         return handleBridgeReply(args, gateway);
    case 'bridge_ack':           return handleBridgeAck(args, gateway);
    case 'gateway_stats':        return handleGatewayStats(args, gateway);
    case 'cost_summary':         return handleCostSummary(args, gateway);
    case 'logs_query':           return handleLogsQuery(args, gateway);
    case 'error_history':        return handleErrorHistory(args, gateway);
    case 'project_create':       return handleProjectCreate(args, gateway);
    case 'project_list':         return handleProjectList(args, gateway);
    case 'project_get':          return handleProjectGet(args, gateway);
    case 'project_summary':      return handleProjectSummary(args, gateway);
    case 'context_save':         return handleContextSave(args, gateway);
    case 'context_retrieve':     return handleContextRetrieve(args, gateway);
    case 'context_list':         return handleContextList(args, gateway);
    case 'project_connect':      return handleProjectConnect(args, gateway);
    case 'project_disconnect':   return handleProjectDisconnect(args, gateway);
    // v2 tools
    case 'task_delete':          return handleTaskDelete(args, gateway);
    case 'task_audit':           return handleTaskAudit(args, gateway);
    case 'task_batch_status':    return handleTaskBatchStatus(args, gateway);
    case 'project_update':       return handleProjectUpdate(args, gateway);
    case 'project_delete':       return handleProjectDelete(args, gateway);
    case 'phase_add':            return handlePhaseAdd(args, gateway);
    case 'phase_delete':         return handlePhaseDelete(args, gateway);
    case 'phase_list':           return handlePhaseList(args, gateway);
    case 'telemetry_report':     return handleTelemetryReport(args, gateway);
    case 'sidecar_health':       return handleSidecarHealth(args, gateway);
    case 'model_list':           return handleModelList(args, gateway);
    case 'my_stats':             return handleMyStats(args, gateway);
    case 'subagent_list':        return handleSubagentList(args, gateway);
    case 'subagent_register':    return handleSubagentRegister(args, gateway);
    case 'subagent_complete':    return handleSubagentComplete(args, gateway);
    case 'bridge_broadcast':     return handleBridgeBroadcast(args, gateway);
    case 'bridge_thread':        return handleBridgeThread(args, gateway);
    case 'bridge_mark_read':     return handleBridgeMarkRead(args, gateway);
    case 'stale_agents':         return handleStaleAgents(args, gateway);
    case 'agent_update':         return handleAgentUpdate(args, gateway);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function _argsOrEmpty(args) {
  return args || {};
}

async function handleHealthCheck(_args, gateway) {
  return gatewayJson(gateway, '/api/health');
}

async function handleRouteRequest(args, gateway) {
  const { provider, model, messages, max_tokens = 4096, temperature = 0.7 } = args;
  if (!provider) throw new Error('provider is required');
  if (!model) throw new Error('model is required');
  if (!Array.isArray(messages)) throw new Error('messages is required');

  const routeMap = {
    anthropic: '/v1/messages',
    openai: '/v1/chat/completions',
    openrouter: '/openrouter/v1/chat/completions',
    ollama: '/api/chat',
  };
  const targetPath = routeMap[provider];
  if (!targetPath) throw new Error(`unsupported provider: ${provider}`);

  const headers = { 'content-type': 'application/json' };
  if (gateway.config.agentToken) headers['x-cortex-token'] = gateway.config.agentToken;

  const body = provider === 'anthropic'
    ? { model, messages, max_tokens, temperature }
    : provider === 'ollama'
      ? { model, messages, options: { temperature }, stream: false }
      : { model, messages, max_tokens, temperature };

  const response = await fetch(`${gateway.config.gatewayUrl}${targetPath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  if (!response.ok) {
    throw new Error(typeof parsed === 'object' ? JSON.stringify(parsed) : String(parsed));
  }

  return parsed;
}

async function handleAgentStatus(args, gateway) {
  const agentId = args.agent_id || args.agent;
  return gatewayJson(gateway, agentId ? `/api/agents/${encodeURIComponent(agentId)}` : '/api/agents');
}

async function handleGetNextTask(args, gateway) {
  const { platform } = agentContext(gateway, args);
  return gatewayJson(gateway, `/api/tasks/next?platform=${encodeURIComponent(platform)}`);
}

async function handleTaskGet(args, gateway) {
  if (!args.task_id) throw new Error('task_id is required');
  return gatewayJson(gateway, `/api/tasks/${encodeURIComponent(args.task_id)}`);
}

async function handleClaimTask(args, gateway) {
  const { platform } = agentContext(gateway, args);
  if (!args.task_id) throw new Error('task_id is required');
  const response = await gatewayJson(gateway, `/api/tasks/${encodeURIComponent(args.task_id)}/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform }),
  });

  // Auto sub-agent tracking: register a sub-agent event when a task is claimed
  const agent = gateway.config.agentId;
  if (agent && response.title) {
    try {
      const regResult = await gatewayJson(gateway, '/api/subagents/event', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          parent_agent: agent,
          subagent_id: `${agent}:task-${args.task_id.slice(0, 8)}-${Date.now()}`,
          subagent_type: 'task-worker',
          description: response.title || `Task ${args.task_id.slice(0, 8)}`,
          task_id: args.task_id,
        }),
      });
      // Store the event_id on the response so it can be used later for completion
      if (regResult?.event_id) response._subagent_event_id = regResult.event_id;
    } catch {}
  }

  return persistTaskState(gateway, response, 'sync', args.task_id);
}


async function handleReportProgress(args, gateway) {
  if (!args.task_id) throw new Error('task_id is required');
  if (!args.status) throw new Error('status is required');
  if (!args.summary) throw new Error('summary is required');

  const taskId = args.task_id;
  const response = await gatewayJson(gateway, `/api/tasks/${encodeURIComponent(taskId)}/progress`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      status: args.status,
      summary: args.summary,
      files_changed: args.files_changed || [],
    }),
  });

  return persistTaskState(gateway, response, 'sync', taskId);
}

async function handleSubmitResult(args, gateway) {
  if (!args.task_id) throw new Error('task_id is required');
  if (!args.summary) throw new Error('summary is required');
  const response = await gatewayJson(gateway, `/api/tasks/${encodeURIComponent(args.task_id)}/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      summary: args.summary,
      files_changed: args.files_changed || [],
    }),
  });

  // Auto sub-agent tracking: complete any sub-agent registered for this task
  const agent = gateway.config.agentId;
  if (agent) {
    try {
      const subagents = await gatewayJson(gateway, `/api/subagents?parent=${encodeURIComponent(agent)}&limit=50`);
      const active = subagents?.subagents?.find(s => s.task_id === args.task_id && s.status === 'running');
      if (active) {
        await gatewayJson(gateway, '/api/subagents/complete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            event_id: active.id,
            status: 'completed',
            result_summary: args.summary?.slice(0, 200) || null,
          }),
        });
      }
    } catch {}
  }

  return persistTaskState(gateway, response, 'sync', args.task_id);
}

async function handleRequestVerification(args, gateway) {
  if (!args.task_id) throw new Error('task_id is required');
  const response = await gatewayJson(gateway, `/api/tasks/${encodeURIComponent(args.task_id)}/request-review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      reviewer: args.reviewer || null,
    }),
  });
  return persistTaskState(gateway, response, 'sync', args.task_id);
}

async function handleTaskApprove(args, gateway) {
  if (!args.task_id) throw new Error('task_id is required');
  return gatewayJson(gateway, `/api/tasks/${encodeURIComponent(args.task_id)}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ comment: args.comment || null }),
  });
}

async function handleTaskReject(args, gateway) {
  if (!args.task_id) throw new Error('task_id is required');
  if (!args.reason) throw new Error('reason is required');
  return gatewayJson(gateway, `/api/tasks/${encodeURIComponent(args.task_id)}/reject`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: args.reason, guidance: args.guidance || null }),
  });
}

async function handleTaskUpdate(args, gateway) {
  if (!args.task_id) throw new Error('task_id is required');
  const body = {};
  if (args.title !== undefined) body.title = args.title;
  if (args.description !== undefined) body.description = args.description;
  if (args.priority !== undefined) body.priority = args.priority;
  if (args.tags !== undefined) body.tags = args.tags;
  return gatewayJson(gateway, `/api/tasks/${encodeURIComponent(args.task_id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function handleTaskCancel(args, gateway) {
  if (!args.task_id) throw new Error('task_id is required');
  if (!args.reason) throw new Error('reason is required');
  return gatewayJson(gateway, `/api/tasks/${encodeURIComponent(args.task_id)}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: args.reason }),
  });
}

async function handleHeartbeat(args, gateway) {
  const t0 = Date.now();
  const { agentId, platform } = agentContext(gateway);
  const stmts = getStmts();

  // Mirror exactly what cortex-tasks.js#heartbeat() does
  // MCP path has platform context; HTTP path passes null — intentional delta
  stmts.upsertHeartbeat.run(agentId, platform, args.task_id || null, args.task_id || null, args.status || 'active');
  try { stmts.touchAgent.run(agentId, agentId); } catch { /* best effort */ }

  // Audit trail — required, must not be skipped (same columns as HTTP path)
  stmts.insertLog.run(
    genId(), 'MCP', '/api/agents/heartbeat',
    null, null, agentId, null,
    0, 0, 0,
    Date.now() - t0, 200, null,
  );

  try {
    broadcastLog({ type: 'agent:heartbeat', data: {
      agent: agentId,
      status: args.status || 'active',
      current_task: args.task_id || null,
      timestamp: new Date().toISOString(),
    }});
  } catch { /* broadcast must never break the main operation */ }

  const response = {
    agent_id: agentId,
    received_at: new Date().toISOString(),
    next_heartbeat_before: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  };

  if (args.task_id) {
    return persistTaskState(gateway, response, 'sync', args.task_id);
  }
  return response;
}

async function handleAgentRegister(args, gateway) {
  if (!args.name) throw new Error('name is required');
  if (!args.platform) throw new Error('platform is required');
  return gatewayJson(gateway, '/api/agents/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: args.name,
      platform: args.platform,
      model: args.model || null,
      provider: args.provider || null,
    }),
  });
}

async function handleTaskCreate(args, gateway) {
  if (!args.title) throw new Error('title is required');
  if (!args.description) throw new Error('description is required');
  if (!args.project_id) throw new Error('project_id is required');

  let phaseNumber = args.phase_number;
  if (!phaseNumber) {
    const phases = await gatewayJson(gateway, `/api/projects/${encodeURIComponent(args.project_id)}/phases`);
    phaseNumber = phases.phases && phases.phases.length > 0
      ? Math.max(...phases.phases.map(p => p.phase_number))
      : 1;
  }

  const response = await gatewayJson(gateway, '/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: args.title,
      description: args.description,
      project_id: args.project_id,
      phase_number: phaseNumber,
      priority: args.priority || 'medium',
      tags: args.tags || [],
    }),
  });
  return response;
}

async function handleTaskList(args, gateway) {
  const limit = args.limit || 50;
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (args.status) params.set('status', args.status);
  if (args.agent) params.set('agent', args.agent);
  if (args.project_id) params.set('project_id', args.project_id);
  if (args.source) params.set('source', args.source);
  return gatewayJson(gateway, `/api/tasks?${params.toString()}`);
}

async function handleTaskRelease(args, gateway) {
  if (!args.task_id) throw new Error('task_id is required');
  const response = await gatewayJson(gateway, `/api/tasks/${encodeURIComponent(args.task_id)}/release`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      reason: args.reason || null,
    }),
  });
  return persistTaskState(gateway, response, 'clear', args.task_id);
}

async function handleTaskReassign(args, gateway) {
  if (!args.task_id) throw new Error('task_id is required');
  if (!args.new_agent) throw new Error('new_agent is required');
  const response = await gatewayJson(gateway, `/api/tasks/${encodeURIComponent(args.task_id)}/reassign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      new_agent: args.new_agent,
    }),
  });
  return persistTaskState(gateway, response, 'clear', args.task_id);
}

async function handleTaskComment(args, gateway) {
  if (!args.task_id) throw new Error('task_id is required');
  if (!args.comment) throw new Error('comment is required');
  return gatewayJson(gateway, `/api/tasks/${encodeURIComponent(args.task_id)}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ comment: args.comment }),
  });
}

async function handleTaskReopen(args, gateway) {
  if (!args.task_id) throw new Error('task_id is required');
  if (!args.reason) throw new Error('reason is required');
  const response = await gatewayJson(gateway, `/api/tasks/${encodeURIComponent(args.task_id)}/reopen`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: args.reason }),
  });
  return persistTaskState(gateway, response, 'clear', args.task_id);
}

async function handleBridgeSend(args, gateway) {
  if (!args.to) throw new Error('to is required');
  // Pass through all fields — gateway validates by message type
  return gatewayJson(gateway, '/api/bridge/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
}

async function handleBridgeInbox(args, gateway) {
  const agent = gateway.config.agentId;
  if (!agent) throw new Error('agent identity not configured');
  const params = new URLSearchParams();
  params.set('limit', String(args.limit || 20));
  if (args.unread_only !== undefined) params.set('unread_only', String(args.unread_only));
  if (args.mark_read !== undefined) params.set('mark_read', String(args.mark_read));
  // summary_only mode: return id/from/subject/type only — skip full body to save tokens
  if (args.summary_only) params.set('summary_only', 'true');
  return gatewayJson(gateway, `/api/bridge/inbox/${encodeURIComponent(agent)}?${params.toString()}`);
}

async function handleBridgePoll(args, gateway) {
  const agent = gateway.config.agentId;
  if (!agent) throw new Error('agent identity not configured');
  const params = new URLSearchParams();
  params.set('limit', String(args.limit || 20));
  params.set('unread_only', 'true');
  params.set('mark_read', 'false');
  const result = await gatewayJson(gateway, `/api/bridge/inbox/${encodeURIComponent(agent)}?${params.toString()}`);
  return { messages: result.messages || [], count: result.messages?.length || 0 };
}

async function handleBridgeReply(args, gateway) {
  if (!args.message_id) throw new Error('message_id is required');
  if (!args.body) throw new Error('body is required');
  return gatewayJson(gateway, `/api/bridge/reply/${encodeURIComponent(args.message_id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: args.body }),
  });
}

async function handleBridgeAck(args, gateway) {
  if (!args.message_id) throw new Error('message_id is required');
  return gatewayJson(gateway, `/api/bridge/ack/${encodeURIComponent(args.message_id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

async function handleGatewayStats(args, gateway) {
  const period = args.period || 'today';
  return gatewayJson(gateway, `/api/stats?period=${encodeURIComponent(period)}`);
}

async function handleCostSummary(args, gateway) {
  const agentId = gateway.config.agentId;
  const params = new URLSearchParams();
  params.set('period', args.period || 'today');
  if (args.task_id) params.set('task_id', args.task_id);
  return gatewayJson(gateway, `/api/costs/${encodeURIComponent(agentId)}?${params.toString()}`);
}

async function handleLogsQuery(args, gateway) {
  const params = new URLSearchParams();
  params.set('limit', String(args.limit || 20));
  if (args.status) params.set('status', args.status);
  if (args.since) params.set('since', args.since);
  return gatewayJson(gateway, `/api/gateway/logs?${params.toString()}`);
}

async function handleErrorHistory(args, gateway) {
  const params = new URLSearchParams();
  params.set('limit', String(args.limit || 10));
  if (args.since) params.set('since', args.since);
  return gatewayJson(gateway, `/api/errors?${params.toString()}`);
}

async function handleProjectCreate(args, gateway) {
  if (!args.name) throw new Error('name is required');
  return gatewayJson(gateway, '/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: args.name, description: args.description || null }),
  });
}

async function handleProjectList(_args, gateway) {
  return gatewayJson(gateway, '/api/projects');
}

async function handleProjectGet(args, gateway) {
  if (!args.project_id) throw new Error('project_id is required');
  return gatewayJson(gateway, `/api/projects/${encodeURIComponent(args.project_id)}`);
}

async function handleProjectSummary(args, gateway) {
  if (!args.project_id) throw new Error('project_id is required');
  return gatewayJson(gateway, `/api/projects/${encodeURIComponent(args.project_id)}/summary`);
}

async function handleContextSave(args, gateway) {
  if (!args.context_type) throw new Error('context_type is required');
  if (!args.content) throw new Error('content is required');
  return gatewayJson(gateway, '/api/bookkeeper/context', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
}

async function handleContextRetrieve(args, gateway) {
  const params = new URLSearchParams();
  if (args.tags?.length) params.set('tags', args.tags.join(','));
  if (args.query) params.set('query', args.query);
  if (args.since) params.set('since', args.since);
  if (args.task_id) params.set('task_id', args.task_id);
  params.set('limit', String(args.limit || 5));
  return gatewayJson(gateway, `/api/bookkeeper/context?${params.toString()}`);
}

async function handleContextList(args, gateway) {
  const params = new URLSearchParams();
  params.set('limit', String(args.limit || 20));
  if (args.context_type) params.set('type', args.context_type);
  return gatewayJson(gateway, `/api/bookkeeper/contexts?${params.toString()}`);
}

async function handleProjectConnect(args, gateway) {
  if (!args.project_id) throw new Error('project_id is required');
  const project = await gatewayJson(gateway, `/api/projects/${encodeURIComponent(args.project_id)}`);
  if (!project || project.error) throw new Error('project not found');

  const runtimeDir = gateway.config.runtimeDir || path.dirname(gateway.config.currentTaskFile || '/tmp/fallback');
  const agentId = gateway.config.agentId;
  const projectFile = path.join(runtimeDir, `${agentId}-active-project`);
  await mkdir(path.dirname(projectFile), { recursive: true });
  await writeFile(projectFile, `${args.project_id}\n`, 'utf8');

  return {
    connected: true,
    project_id: args.project_id,
    project_name: project.name || null,
    scope: '~/Cortex',
    project_file: projectFile,
  };
}

async function handleProjectDisconnect(_args, gateway) {
  const runtimeDir = gateway.config.runtimeDir || path.dirname(gateway.config.currentTaskFile || '/tmp/fallback');
  const agentId = gateway.config.agentId;
  const projectFile = path.join(runtimeDir, `${agentId}-active-project`);
  await rm(projectFile, { force: true });
  return { disconnected: true };
}

// ═══ MCP Tools v2 Handlers ═══

async function handleTaskDelete(args, gateway) {
  if (!args.task_id) throw new Error('task_id is required');
  // Agents request deletion — admin approves via dashboard
  return gatewayJson(gateway, `/api/tasks/${encodeURIComponent(args.task_id)}/request-delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: args.reason || 'Deletion requested by agent' }),
  });
}

async function handleTaskAudit(args, gateway) {
  if (!args.task_id) throw new Error('task_id is required');
  return gatewayJson(gateway, `/api/tasks/${encodeURIComponent(args.task_id)}/audit`);
}

async function handleTaskBatchStatus(args, gateway) {
  if (!args.task_ids || !Array.isArray(args.task_ids)) throw new Error('task_ids array is required');
  if (args.task_ids.length > 50) throw new Error('max 50 task IDs per batch');
  const results = await Promise.all(
    args.task_ids.map(id =>
      gatewayJson(gateway, `/api/tasks/${encodeURIComponent(id)}`).catch(e => ({ id, error: e.message }))
    )
  );
  return {
    tasks: results.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      assigned_agent: t.assigned_agent,
      error: t.error || undefined,
    })),
    total: results.length,
  };
}

async function handleProjectUpdate(args, gateway) {
  if (!args.project_id) throw new Error('project_id is required');
  const body = {};
  if (args.name) body.name = args.name;
  if (args.description) body.description = args.description;
  if (args.status) body.status = args.status;
  return gatewayJson(gateway, `/api/projects/${encodeURIComponent(args.project_id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function handleProjectDelete(args, gateway) {
  if (!args.project_id) throw new Error('project_id is required');
  return gatewayJson(gateway, `/api/projects/${encodeURIComponent(args.project_id)}`, { method: 'DELETE' });
}

async function handlePhaseAdd(args, gateway) {
  if (!args.project_id) throw new Error('project_id is required');
  return gatewayJson(gateway, `/api/projects/${encodeURIComponent(args.project_id)}/phases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
}

async function handlePhaseDelete(args, gateway) {
  if (!args.project_id) throw new Error('project_id is required');
  if (!args.phase_number) throw new Error('phase_number is required');
  return gatewayJson(gateway, `/api/projects/${encodeURIComponent(args.project_id)}/phases/${args.phase_number}`, { method: 'DELETE' });
}

async function handlePhaseList(args, gateway) {
  if (!args.project_id) throw new Error('project_id is required');
  return gatewayJson(gateway, `/api/projects/${encodeURIComponent(args.project_id)}/phases`);
}

async function handleTelemetryReport(args, gateway) {
  return gatewayJson(gateway, '/api/gateway/telemetry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      method: args.method || 'AGENT_REPORT',
      endpoint: args.endpoint || '',
      provider: 'anthropic',
      model: args.model || 'claude-opus-4-6',
      tokens_in: args.tokens_in || 0,
      tokens_out: args.tokens_out || 0,
      cost_usd: args.cost_usd || 0,
      latency_ms: args.latency_ms || 0,
      status_code: 200,
    }),
  });
}

async function handleSidecarHealth(_args, gateway) {
  const sidecars = [
    { name: 'gateway', port: 4840, path: '/health' },
    { name: 'backend', port: 4830, path: '/health' },
    { name: 'bookkeeper', port: 4931, path: '/health' },
    { name: 'autopsy', port: 4936, path: '/health' },
    { name: 'sentinel', port: 4937, path: '/health' },
    { name: 'verifier', port: 4938, path: '/health' },
    { name: 'runtime', port: 4835, path: '/health' },
    { name: 'ollama', port: 11434, path: '/api/tags' },
    { name: 'chromadb', port: 8000, path: '/api/v1/heartbeat' },
  ];
  const results = await Promise.all(sidecars.map(async (s) => {
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}${s.path}`, { signal: AbortSignal.timeout(2000) });
      return { ...s, status: res.ok ? 'healthy' : 'degraded', http_status: res.status };
    } catch {
      return { ...s, status: 'down', http_status: null };
    }
  }));
  return { services: results, healthy: results.filter(r => r.status === 'healthy').length, total: results.length };
}

async function handleModelList(_args, gateway) {
  return gatewayJson(gateway, '/api/model/list');
}

async function handleMyStats(args, gateway) {
  const agent = gateway.config.agentId;
  return gatewayJson(gateway, `/api/costs/${encodeURIComponent(agent)}${args.period ? `?period=${args.period}` : ''}`);
}

async function handleSubagentList(args, gateway) {
  const agent = gateway.config.agentId;
  const limit = args.limit || 50;
  return gatewayJson(gateway, `/api/subagents?parent=${encodeURIComponent(agent)}&limit=${limit}`);
}

async function handleSubagentRegister(args, gateway) {
  if (!args.description) throw new Error('description is required');
  const agent = gateway.config.agentId;
  const platform = gateway.config.agentPlatform || agent;
  return gatewayJson(gateway, '/api/subagents/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      parent_agent: agent,
      subagent_id: `${agent}:${args.subagent_type || 'general-purpose'}-${Date.now()}`,
      subagent_type: args.subagent_type || 'general-purpose',
      description: args.description,
      task_id: args.task_id || null,
    }),
  });
}

async function handleSubagentComplete(args, gateway) {
  if (!args.event_id) throw new Error('event_id is required');
  return gatewayJson(gateway, '/api/subagents/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event_id: args.event_id,
      status: args.status || 'completed',
      duration_ms: args.duration_ms || 0,
      tool_calls: args.tool_calls || 0,
      result_summary: args.result_summary || null,
    }),
  });
}

async function handleBridgeBroadcast(args, gateway) {
  const agents = await gatewayJson(gateway, '/api/agents');
  const agentList = (agents.agents || []).filter(a => a.agent_id !== gateway.config.agentId && a.agent_id !== 'admin');
  const results = await Promise.all(agentList.map(a =>
    gatewayJson(gateway, '/api/bridge/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        to: a.agent_id,
        type: args.type || 'status_update',
        subject: args.subject || 'broadcast',
        body: args.body,
        task_id: args.task_id || null,
        priority: args.priority || 'normal',
      }),
    }).catch(e => ({ agent: a.agent_id, error: e.message }))
  ));
  return { sent_to: agentList.map(a => a.agent_id), results, count: agentList.length };
}

async function handleBridgeThread(args, gateway) {
  if (!args.message_id) throw new Error('message_id is required');
  // Walk the in_reply_to chain
  const thread = [];
  let currentId = args.message_id;
  const seen = new Set();
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    try {
      const msg = await gatewayJson(gateway, `/api/bridge/inbox?limit=200`);
      const messages = msg.messages || [];
      const found = messages.find(m => m.message_id === currentId || m.id === currentId);
      if (!found) break;
      thread.unshift(found);
      currentId = found.in_reply_to;
    } catch {
      break;
    }
  }
  return { thread, count: thread.length };
}

async function handleBridgeMarkRead(args, gateway) {
  if (!args.message_ids || !Array.isArray(args.message_ids)) throw new Error('message_ids array is required');
  const results = await Promise.all(args.message_ids.map(id =>
    gatewayJson(gateway, `/api/bridge/ack/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }).catch(e => ({ id, error: e.message }))
  ));
  return { marked: args.message_ids.length, results };
}

async function handleStaleAgents(args, gateway) {
  const seconds = args.seconds || 600;
  return gatewayJson(gateway, `/agents/stale?seconds=${seconds}`);
}

async function handleAgentUpdate(args, gateway) {
  if (!args.agent_id) throw new Error('agent_id is required');
  return gatewayJson(gateway, `/api/agents/${encodeURIComponent(args.agent_id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: args.model,
      provider: args.provider,
      status: args.status,
    }),
  });
}
