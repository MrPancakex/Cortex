/**
 * Gateway API Proxy — intercepts LLM requests, forwards to providers, logs everything.
 *
 * Supports: Anthropic, OpenAI, OpenRouter, Ollama
 * Features: SSE streaming passthrough, token/cost tracking, error forwarding
 */
import crypto from 'node:crypto';
import { getStmts } from './db.js';
import { readCredential, resolveCredentialMode } from './credentials.js';

// ---------------------------------------------------------------------------
// Model pricing (per 1M tokens)
// ---------------------------------------------------------------------------
const MODEL_COSTS = {
  'claude-sonnet-4-6':           { input: 3.0,   output: 15.0 },
  'claude-sonnet-4-20250514':    { input: 3.0,   output: 15.0 },
  'claude-haiku-4-5':            { input: 0.80,  output: 4.0 },
  'claude-haiku-3-5-20241022':   { input: 0.80,  output: 4.0 },
  'claude-opus-4-6':             { input: 15.0,  output: 75.0 },
  'claude-opus-4-20250514':      { input: 15.0,  output: 75.0 },
  'gpt-4o':                      { input: 2.50,  output: 10.0 },
  'gpt-4o-mini':                 { input: 0.15,  output: 0.60 },
  'gpt-4.1':                     { input: 2.0,   output: 8.0 },
  'gpt-4.1-mini':                { input: 0.40,  output: 1.60 },
  'gpt-4.1-nano':                { input: 0.10,  output: 0.40 },
};

const DEFAULT_COST = { input: 0, output: 0 };

function getCost(model) {
  if (!model) return DEFAULT_COST;
  if (MODEL_COSTS[model]) return MODEL_COSTS[model];
  for (const key of Object.keys(MODEL_COSTS)) {
    if (model.startsWith(key)) return MODEL_COSTS[key];
  }
  return DEFAULT_COST;
}

function calcCostUsd(model, tokensIn, tokensOut) {
  const pricing = getCost(model);
  return (tokensIn * pricing.input + tokensOut * pricing.output) / 1_000_000;
}

export { calcCostUsd };

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

const PROVIDER_ROUTES = [
  { prefix: '/v1/messages',          provider: 'anthropic',  target: 'https://api.anthropic.com/v1/messages' },
  { prefix: '/v1/responses',         provider: 'openai',     target: 'https://api.openai.com/v1/responses' },
  { prefix: '/v1/chat/completions',  provider: 'openai',     target: 'https://api.openai.com/v1/chat/completions' },
  { prefix: '/v1/completions',       provider: 'openai',     target: 'https://api.openai.com/v1/completions' },
  { prefix: '/v1/embeddings',        provider: 'openai',     target: 'https://api.openai.com/v1/embeddings' },
  { prefix: '/api/chat',             provider: 'ollama',     target: OLLAMA_HOST + '/api/chat' },
  { prefix: '/api/generate',         provider: 'ollama',     target: OLLAMA_HOST + '/api/generate' },
  { prefix: '/api/tags',             provider: 'ollama',     target: OLLAMA_HOST + '/api/tags' },
  { prefix: '/openrouter/v1/',       provider: 'openrouter', target: 'https://openrouter.ai/api/v1/' },
];


// ---------------------------------------------------------------------------
// Agent ID extraction from URL path: /agent/{name}/v1/messages -> agentId=name
// ---------------------------------------------------------------------------
const AGENT_PREFIX = /^\/agent\/([a-zA-Z0-9_-]+)(\/.*)$/;

function stripAgentPrefix(pathname) {
  const m = pathname.match(AGENT_PREFIX);
  if (m) return { agentId: m[1], cleanPath: m[2] };
  return { agentId: null, cleanPath: pathname };
}

/**
 * Match a request path to a provider route.
 * Supports /agent/{name}/ prefix for auto-tagging.
 * Returns { provider, targetUrl, pathAgentId } or null if no match.
 */
export function matchRoute(pathname, search = '') {
  const { agentId: pathAgentId, cleanPath } = stripAgentPrefix(pathname);
  pathname = cleanPath;
  // OpenRouter wildcard — strip /openrouter prefix and forward the rest
  if (pathname.startsWith('/openrouter/v1/')) {
    const rest = pathname.slice('/openrouter'.length); // keeps /v1/...
    return { provider: 'openrouter', targetUrl: 'https://openrouter.ai/api' + rest + search, pathAgentId };
  }

  for (const route of PROVIDER_ROUTES) {
    if (route.provider === 'openrouter') continue; // handled above
    if (pathname === route.prefix || pathname.startsWith(route.prefix + '/')) {
      const suffix = pathname.slice(route.prefix.length);
      return { provider: route.provider, targetUrl: route.target + suffix + search, pathAgentId };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Auth header injection
//
// Two credential modes (determined by resolveCredentialMode):
//   passthrough — caller sent their own auth, forward it untouched
//   managed     — no caller auth, Cortex attaches its own from LoadCredential
//
// Auth headers forwarded in-memory only — never written to DB or logs.
// ---------------------------------------------------------------------------

function passthroughProviderHeaders(provider, originalHeaders) {
  const headers = {};
  switch (provider) {
    case 'anthropic': {
      const callerAuth = originalHeaders.get('authorization');
      const callerKey = originalHeaders.get('x-api-key');
      if (callerAuth) headers['authorization'] = callerAuth;
      if (callerKey) headers['x-api-key'] = callerKey;
      headers['anthropic-version'] = originalHeaders.get('anthropic-version') || '2025-02-19';
      const beta = originalHeaders.get('anthropic-beta');
      if (beta) headers['anthropic-beta'] = beta;
      break;
    }
    case 'openai': {
      const callerAuth = originalHeaders.get('authorization');
      if (callerAuth) headers['authorization'] = callerAuth;
      break;
    }
    case 'openrouter': {
      const callerAuth = originalHeaders.get('authorization');
      if (callerAuth) headers['authorization'] = callerAuth;
      break;
    }
    case 'ollama':
      break;
  }
  return headers;
}

function managedProviderHeaders(provider) {
  const headers = {};
  switch (provider) {
    case 'anthropic': {
      const key = readCredential('anthropic-key');
      if (key) headers['x-api-key'] = key;
      headers['anthropic-version'] = '2025-02-19';
      break;
    }
    case 'openai': {
      const key = readCredential('openai-key');
      if (key) headers['authorization'] = 'Bearer ' + key;
      break;
    }
    case 'openrouter': {
      const key = readCredential('openrouter-key');
      if (key) headers['authorization'] = 'Bearer ' + key;
      break;
    }
    case 'ollama':
      break;
  }
  return headers;
}

export function buildHeaders(provider, originalHeaders) {
  const headers = {};

  // Copy safe headers from original request
  const safeHeaders = ['content-type', 'accept', 'user-agent', 'x-request-id'];
  for (const name of safeHeaders) {
    const val = originalHeaders.get(name);
    if (val) headers[name] = val;
  }
  if (!headers['content-type']) {
    headers['content-type'] = 'application/json';
  }

  // Project ID is advisory metadata. Agent identity must come from a validated Cortex token.
  const projectId = originalHeaders.get('x-cortex-project-id');

  // Determine credential mode from caller's headers
  const hasCallerAuth = originalHeaders.get('authorization') || originalHeaders.get('x-api-key');
  const credentialMode = hasCallerAuth ? 'passthrough' : 'managed';

  // Apply provider-specific auth headers
  const providerHeaders = credentialMode === 'passthrough'
    ? passthroughProviderHeaders(provider, originalHeaders)
    : managedProviderHeaders(provider);

  Object.assign(headers, providerHeaders);

  return { headers, projectId, credentialMode };
}

// ---------------------------------------------------------------------------
// Token extraction from response bodies
// ---------------------------------------------------------------------------
export function extractUsage(provider, body) {
  if (!body || typeof body !== 'object') return { tokensIn: 0, tokensOut: 0 };

  const usage = body.usage;
  if (!usage) {
    // Ollama puts counts at top level
    if (provider === 'ollama') {
      return {
        tokensIn: body.prompt_eval_count || 0,
        tokensOut: body.eval_count || 0,
      };
    }
    return { tokensIn: 0, tokensOut: 0 };
  }

  switch (provider) {
    case 'anthropic':
      return {
        tokensIn: usage.input_tokens || 0,
        tokensOut: usage.output_tokens || 0,
      };
    case 'openai':
    case 'openrouter':
      return {
        // Chat completions shape: prompt_tokens/completion_tokens
        // Responses API shape: input_tokens/output_tokens
        tokensIn: usage.prompt_tokens || usage.input_tokens || 0,
        tokensOut: usage.completion_tokens || usage.output_tokens || 0,
      };
    case 'ollama':
      return {
        tokensIn: usage.prompt_eval_count || body.prompt_eval_count || 0,
        tokensOut: usage.eval_count || body.eval_count || 0,
      };
    default:
      return { tokensIn: 0, tokensOut: 0 };
  }
}

function extractModel(body) {
  if (!body || typeof body !== 'object') return null;
  return body.model || null;
}

// ---------------------------------------------------------------------------
// Streaming token extraction
// ---------------------------------------------------------------------------
export function extractStreamingUsage(provider, chunks) {
  let tokensIn = 0;
  let tokensOut = 0;

  for (const chunk of chunks) {
    if (!chunk) continue;
    const usage = chunk.usage;
    if (usage) {
      switch (provider) {
        case 'anthropic':
          if (usage.input_tokens) tokensIn = usage.input_tokens;
          if (usage.output_tokens) tokensOut = usage.output_tokens;
          break;
        case 'openai':
        case 'openrouter':
          // Chat completions shape
          if (usage.prompt_tokens) tokensIn = usage.prompt_tokens;
          if (usage.completion_tokens) tokensOut = usage.completion_tokens;
          // Responses API shape
          if (usage.input_tokens) tokensIn = usage.input_tokens;
          if (usage.output_tokens) tokensOut = usage.output_tokens;
          break;
      }
    }
    // Anthropic sends message_delta with usage at the end
    if (chunk.type === 'message_delta' && chunk.usage) {
      if (chunk.usage.output_tokens) tokensOut = chunk.usage.output_tokens;
    }
    // Anthropic sends message_start with input token count
    if (chunk.type === 'message_start' && chunk.message && chunk.message.usage) {
      if (chunk.message.usage.input_tokens) tokensIn = chunk.message.usage.input_tokens;
    }
    // Responses API sends response.completed with full usage in response.usage
    if (chunk.type === 'response.completed' && chunk.response && chunk.response.usage) {
      const u = chunk.response.usage;
      if (u.input_tokens) tokensIn = u.input_tokens;
      if (u.output_tokens) tokensOut = u.output_tokens;
    }
  }

  return { tokensIn, tokensOut };
}

export function collectUsageEventsFromSseText(text) {
  const usageEvents = [];
  const events = text.split('\n\n');
  const complete = text.endsWith('\n\n');
  const remaining = complete ? '' : (events.pop() || '');

  for (const event of events) {
    const dataLines = event
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6).trim())
      .filter(Boolean);

    if (!dataLines.length) continue;

    const data = dataLines.join('\n');
    if (data === '[DONE]') continue;

    try {
      const parsed = JSON.parse(data);
      if (
        parsed.usage ||
        parsed.type === 'message_delta' ||
        parsed.type === 'message_start' ||
        parsed.type === 'response.completed'
      ) {
        usageEvents.push(parsed);
      }
    } catch { /* not valid JSON, skip */ }
  }

  return { usageEvents, remaining };
}

// ---------------------------------------------------------------------------
// WebSocket broadcast registry
// ---------------------------------------------------------------------------
const _wsClients = new Set();

export function addWsClient(ws) { _wsClients.add(ws); }
export function removeWsClient(ws) { _wsClients.delete(ws); }

export function broadcastLog(logEntry) {
  const msg = JSON.stringify({ type: 'gateway_log', data: logEntry });
  for (const ws of _wsClients) {
    try {
      if (ws.readyState === 1) ws.send(msg);
      else _wsClients.delete(ws);
    } catch { _wsClients.delete(ws); }
  }
}

// ---------------------------------------------------------------------------
// Core proxy handler
// ---------------------------------------------------------------------------

/**
 * Handle a proxied API request. Returns a Response object, or null if not a proxy route.
 */
export async function handleProxy(req) {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  const match = matchRoute(pathname, url.search);
  if (!match) return null;

  const { provider, targetUrl, pathAgentId } = match;
  const requestId = crypto.randomUUID();
  const startTime = Date.now();

  // Parse request body for model extraction
  let bodyText = null;
  let bodyObj = null;

  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    try {
      bodyText = await req.text();
      bodyObj = JSON.parse(bodyText);
    } catch {
      bodyText = bodyText || '';
      bodyObj = null;
    }
  }

  const model = extractModel(bodyObj);
  const { headers, projectId, credentialMode } = buildHeaders(provider, req.headers);
  // Agent attribution is derived only from a validated Cortex token.
  const tokenIdentity = req._cortexIdentity || null;
  const agentId = tokenIdentity || null;

  // Detect if client wants streaming
  const isStreaming = bodyObj ? bodyObj.stream === true : false;

  // Build fetch options
  const fetchOpts = { method, headers };
  if (bodyText !== null) {
    fetchOpts.body = bodyText;
  }

  let upstreamRes;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000);
  try {
    upstreamRes = await fetch(targetUrl, { ...fetchOpts, signal: controller.signal });
  } catch (err) {
    clearTimeout(timeoutId);
    const latencyMs = Date.now() - startTime;
    if (err.name === 'AbortError') {
      const logEntry = {
        request_id: requestId,
        method, path: pathname, provider, model,
        agent_id: agentId, project_id: projectId,
        tokens_in: 0, tokens_out: 0, cost_usd: 0,
        latency_ms: 300000, status_code: 504,
        error: 'upstream timeout',
      };
      insertLog(logEntry);
      broadcastLog(logEntry);
      return Response.json(
        { error: 'upstream_timeout', provider, request_id: requestId },
        { status: 504 }
      );
    }
    console.error('[gateway-proxy] upstream error:', provider, err.message);
    const logEntry = {
      request_id: requestId,
      method, path: pathname, provider, model,
      agent_id: agentId, project_id: projectId,
      tokens_in: 0, tokens_out: 0, cost_usd: 0,
      latency_ms: latencyMs, status_code: 502,
      error: err.message,
    };
    insertLog(logEntry);
    broadcastLog(logEntry);

    return Response.json(
      { error: 'upstream_unreachable', provider, request_id: requestId },
      { status: 502 }
    );
  }
  clearTimeout(timeoutId);

  // ------ Streaming response ------
  const contentType = upstreamRes.headers.get('content-type') || '';
  if (isStreaming && contentType.includes('text/event-stream')) {
    // /v1/responses uses a different SSE event shape — proxy raw bytes,
    // do not attempt chat-completions-style chunk parsing.
    const rawPassthrough = pathname === '/v1/responses' || pathname.startsWith('/v1/responses/');
    return handleStreamingResponse(upstreamRes, {
      requestId, method, pathname, provider, model,
      agentId, projectId, startTime, rawPassthrough,
    });
  }

  // ------ Non-streaming response ------
  let responseBody;
  let responseObj = null;
  try {
    responseBody = await upstreamRes.text();
    responseObj = JSON.parse(responseBody);
  } catch {
    responseBody = responseBody || '';
  }

  const latencyMs = Date.now() - startTime;
  const { tokensIn, tokensOut } = extractUsage(provider, responseObj);
  const costUsd = calcCostUsd(model, tokensIn, tokensOut);
  const statusCode = upstreamRes.status;
  const errorMsg = statusCode >= 400
    ? (responseObj && responseObj.error ? (responseObj.error.message || responseObj.error) : null)
    : null;

  const logEntry = {
    request_id: requestId,
    method, path: pathname, provider, model,
    agent_id: agentId, project_id: projectId,
    tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: costUsd,
    latency_ms: latencyMs, status_code: statusCode,
    error: typeof errorMsg === 'object' ? JSON.stringify(errorMsg) : errorMsg,
  };
  insertLog(logEntry);
  broadcastLog(logEntry);

  // Forward response with original status and headers
  const resHeaders = new Headers();
  for (const [k, v] of upstreamRes.headers) {
    if (['content-type', 'x-request-id'].includes(k.toLowerCase())) {
      resHeaders.set(k, v);
    }
  }
  resHeaders.set('x-gateway-request-id', requestId);

  return new Response(responseBody, {
    status: statusCode,
    headers: resHeaders,
  });
}

// ---------------------------------------------------------------------------
// Streaming passthrough with token extraction
// ---------------------------------------------------------------------------
function handleStreamingResponse(upstreamRes, meta) {
  const { requestId, method, pathname, provider, model, agentId, projectId, startTime, rawPassthrough } = meta;
  const usageEvents = [];
  const decoder = new TextDecoder();
  let sseBuffer = '';

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);

      try {
        sseBuffer += decoder.decode(chunk, { stream: true });
        const parsed = collectUsageEventsFromSseText(sseBuffer);
        usageEvents.push(...parsed.usageEvents);
        sseBuffer = parsed.remaining;
      } catch { /* decoding error, skip */ }

      // Raw passthrough mode still proxies bytes untouched; the parsing above is
      // only for usage extraction and does not mutate the stream.
      if (rawPassthrough) return;
    },

    flush() {
      try {
        sseBuffer += decoder.decode();
      } catch { /* decoder flush failed, ignore */ }

      if (sseBuffer.trim()) {
        const parsed = collectUsageEventsFromSseText(sseBuffer + '\n\n');
        usageEvents.push(...parsed.usageEvents);
      }

      // Stream complete — log the request
      const latencyMs = Date.now() - startTime;
      const { tokensIn, tokensOut } = extractStreamingUsage(provider, usageEvents);
      const costUsd = calcCostUsd(model, tokensIn, tokensOut);

      const logEntry = {
        request_id: requestId,
        method, path: pathname, provider, model,
        agent_id: agentId, project_id: projectId,
        tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: costUsd,
        latency_ms: latencyMs, status_code: upstreamRes.status,
        error: null,
      };
      insertLog(logEntry);
      broadcastLog(logEntry);
    },
  });

  const resHeaders = new Headers();
  resHeaders.set('content-type', 'text/event-stream');
  resHeaders.set('cache-control', 'no-cache');
  resHeaders.set('connection', 'keep-alive');
  resHeaders.set('x-gateway-request-id', requestId);

  return new Response(upstreamRes.body.pipeThrough(transformStream), {
    status: upstreamRes.status,
    headers: resHeaders,
  });
}

// ---------------------------------------------------------------------------
// DB insert helper
// ---------------------------------------------------------------------------
function insertLog(entry) {
  try {
    const stmts = getStmts();
    stmts.insertLog.run(
      entry.request_id,
      entry.method,
      entry.path,
      entry.provider || null,
      entry.model || null,
      entry.agent_id || null,
      entry.project_id || null,
      entry.tokens_in || 0,
      entry.tokens_out || 0,
      entry.cost_usd || 0,
      entry.latency_ms || 0,
      entry.status_code || 0,
      entry.error || null,
    );
  } catch (err) {
    console.error('[gateway-proxy] failed to insert log:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Log query helpers (used by route handlers)
// ---------------------------------------------------------------------------
export function queryLogs({ agentId, projectId, model, limit = 100 } = {}) {
  const stmts = getStmts();
  const lim = Math.min(Math.max(1, Number(limit) || 100), 1000);
  const gatewayRows = projectId
    ? stmts.getLogsByProject.all(projectId, lim)
    : agentId
      ? stmts.getLogsByAgent.all(agentId, lim)
      : model
        ? stmts.getLogsByModel.all(model, lim)
        : stmts.getRecentLogs.all(lim);

  if (projectId) return gatewayRows;

  const otelScanLimit = Math.min(Math.max(lim * 10, 1000), 5000);
  const otelRows = stmts.getRecentOtelEvents
    .all(otelScanLimit)
    .filter((row) => {
      if (agentId && row.source_agent !== agentId) return false;
      if (model && row.model !== model) return false;
      return true;
    })
    .map((row) => {
      const status = String(row.status || '').toLowerCase();
      const isError = status.includes('error') || status.includes('fail') || status.includes('exception');
      return {
        id: `otel:${row.id}`,
        request_id: row.run_id || null,
        method: row.event_type || 'OTEL',
        path: row.tool_name || row.thread_id || row.run_id || '',
        provider: row.provider || 'unknown',
        model: row.model || null,
        agent_id: row.source_agent || 'unknown',
        project_id: null,
        tokens_in: row.tokens_in || 0,
        tokens_out: row.tokens_out || 0,
        cost_usd: row.cost_usd || 0,
        latency_ms: row.latency_ms || 0,
        status_code: isError ? 500 : 200,
        error: isError ? row.event_type || row.status || 'OTEL error' : null,
        timestamp: row.timestamp,
        source_table: 'otel_events',
        thread_id: row.thread_id || null,
        tool_name: row.tool_name || null,
        tool_success: row.tool_success,
        event_type: row.event_type || null,
        auth_mode: row.auth_mode || null,
      };
    });

  return [...gatewayRows, ...otelRows]
    .sort((a, b) => {
      const ta = Date.parse(a.timestamp || 0) || 0;
      const tb = Date.parse(b.timestamp || 0) || 0;
      return tb - ta;
    })
    .slice(0, lim);
}

export function queryLogStats() {
  const stmts = getStmts();
  const overall = stmts.getLogStats.get();
  const byProvider = stmts.getLogStatsByProvider.all();
  const byModel = stmts.getLogStatsByModel.all();
  return { overall, byProvider, byModel };
}

/**
 * Check if a request path matches a proxy route.
 */
export function isProxyRoute(pathname) {
  return matchRoute(pathname) !== null;
}
