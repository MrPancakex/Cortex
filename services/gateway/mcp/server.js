import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { CORTEX_TOOLS } from './tools.js';
import { handleToolCall } from './tool-handlers.js';
import { getNextStepHint } from './hints.js';
import { getResources, readResource } from './resources.js';
import { CORTEX_PROMPTS, getPrompt } from './prompts.js';

export function createCortexMCPServer(gateway) {
  const server = new Server(
    { name: 'cortex-gateway', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: CORTEX_TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      const result = await handleToolCall(name, args, gateway);
      const hint = getNextStepHint(name, args, result);
      if (hint && typeof result === 'object' && result && !result.next_step_hint) {
        result.next_step_hint = hint;
      }
      const text = JSON.stringify(result, null, 2);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: getResources() }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const { uri } = req.params;
    try {
      const text = await readResource(uri, gateway);
      return { contents: [{ uri, mimeType: 'text/plain', text }] };
    } catch (err) {
      throw new Error(`Resource error: ${err.message}`);
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: CORTEX_PROMPTS }));

  server.setRequestHandler(GetPromptRequestSchema, (req) => {
    const { name, arguments: args = {} } = req.params;
    return getPrompt(name, args);
  });

  return server;
}

// Bun-native SSE transport.
// SSE protocol: GET /mcp opens stream + sends endpoint event.
// Client then POSTs to /mcp/message?sessionId=xxx.
class BunSSETransport {
  constructor(writer) {
    this._writer = writer;
    this._enc = new TextEncoder();
  }

  async start() {}

  async send(message) {
    const line = `event: message\ndata: ${JSON.stringify(message)}\n\n`;
    try {
      await this._writer.write(this._enc.encode(line));
    } catch {}
  }

  async close() {
    try { await this._writer.close(); } catch {}
    this.onclose?.();
  }
}

const sessions = new Map();      // sessionId -> BunSSETransport
const sessionCreatedAt = new Map(); // sessionId -> timestamp (ms)

// BUG-24: Session limits and TTL
const MAX_SESSIONS = Number(process.env.CORTEX_MCP_MAX_SESSIONS || 100);
const SESSION_TTL_MS = Number(process.env.CORTEX_MCP_SESSION_TTL_MS || 3_600_000); // 1 hour

// Periodic cleanup of expired sessions
const _sessionCleanup = setInterval(() => {
  const now = Date.now();
  for (const [id, created] of sessionCreatedAt) {
    if (now - created > SESSION_TTL_MS) {
      const transport = sessions.get(id);
      if (transport) {
        try { transport.close(); } catch {}
      }
      sessions.delete(id);
      sessionCreatedAt.delete(id);
      // sessionIdentity is cleaned up below if it exists
    }
  }
}, 60_000); // check every 60 seconds
if (_sessionCleanup.unref) _sessionCleanup.unref();

export function createMCPHandler(gateway, { identifyAgent } = {}) {
  // Track session → agent identity mapping
  const sessionIdentity = new Map();

  // Extend the periodic cleanup to also clear sessionIdentity entries
  const _identityCleanup = setInterval(() => {
    for (const id of sessionIdentity.keys()) {
      if (!sessions.has(id)) sessionIdentity.delete(id);
    }
  }, 60_000);
  if (_identityCleanup.unref) _identityCleanup.unref();

  return async function handleMCP(req) {
    const url = new URL(req.url);
    const method = req.method;
    const sessionId = url.searchParams.get('sessionId');

    // Auth: identify agent from token on all MCP requests
    const mcpIdentity = identifyAgent ? identifyAgent(req) : null;

    // POST /mcp/message?sessionId=xxx — incoming JSON-RPC from client
    if (method === 'POST' && url.pathname === '/mcp/message') {
      if (!sessionId || !sessions.has(sessionId)) {
        return new Response(JSON.stringify({ error: 'Session not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      // Verify session belongs to the requesting agent
      const sessionAgent = sessionIdentity.get(sessionId);
      if (!sessionAgent) {
        // Session has no bound identity — should not happen (GET /mcp requires auth)
        return new Response(JSON.stringify({ error: 'forbidden', message: 'session has no bound identity' }), {
          status: 403, headers: { 'content-type': 'application/json' },
        });
      }
      if (mcpIdentity && sessionAgent !== mcpIdentity) {
        return new Response(JSON.stringify({ error: 'forbidden', message: 'session belongs to another agent' }), {
          status: 403, headers: { 'content-type': 'application/json' },
        });
      }
      const transport = sessions.get(sessionId);
      let body;
      try { body = await req.json(); } catch {
        return new Response('Invalid JSON', { status: 400 });
      }
      transport.onmessage?.(body);
      return new Response(null, { status: 202 });
    }

    // GET /mcp — open SSE stream (requires valid token)
    if (method === 'GET') {
      if (!mcpIdentity) {
        return new Response(JSON.stringify({ error: 'unauthorized', message: 'valid X-Cortex-Token required' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }

      // BUG-24: Enforce max session count
      if (sessions.size >= MAX_SESSIONS) {
        return new Response(JSON.stringify({ error: 'too_many_sessions', message: `Server session limit (${MAX_SESSIONS}) reached. Try again later.` }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }

      const id = crypto.randomUUID();
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const enc = new TextEncoder();

      const transport = new BunSSETransport(writer);
      // Per-session gateway context with the authenticated agent's token + identity
      const mcpToken = req.headers.get('x-cortex-token') || null;
      const sessionGateway = {
        ...gateway,
        config: { ...gateway.config, agentId: mcpIdentity, agentPlatform: mcpIdentity, agentToken: mcpToken },
      };
      const server = createCortexMCPServer(sessionGateway);
      await server.connect(transport);
      sessions.set(id, transport);
      sessionIdentity.set(id, mcpIdentity);
      sessionCreatedAt.set(id, Date.now()); // BUG-24: Track creation time for TTL

      // Send endpoint event immediately
      writer.write(enc.encode(`event: endpoint\ndata: /mcp/message?sessionId=${id}\n\n`));

      // Clean up on disconnect
      req.signal?.addEventListener('abort', () => {
        sessions.delete(id);
        sessionIdentity.delete(id);
        sessionCreatedAt.delete(id); // BUG-24: Clean up TTL tracking
        transport.onclose?.();
      });

      process.stderr.write(`[cortex-mcp] session opened: ${id}\n`);
      return new Response(readable, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
        },
      });
    }

    return new Response('Method not allowed', { status: 405 });
  };
}
