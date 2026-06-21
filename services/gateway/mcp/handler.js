import { createCortexMCPServer } from './transport.js';
import { BunSSETransport } from './sse-transport.js';
import {
  sessions, MAX_SESSIONS,
  touchSession, hasSession, getSession, storeSession, dropSession,
} from './sessions.js';

/**
 * HTTP handler for the MCP transport. Serves two paths:
 *   GET  /mcp                    — opens an SSE stream (sends `event: endpoint`).
 *   POST /mcp/message?sessionId= — delivers a JSON-RPC message to the transport.
 *
 * Authentication: every request must carry a valid X-Cortex-Token. Optional
 * X-Cortex-Session lets session-scoped identities (nova-3) coexist with the
 * base identity (nova). POSTs are rejected if the session's bound identity
 * does not match the authenticated identity.
 */
export function createMCPHandler(gateway, { identifyAgent } = {}) {
  // Session → agent identity mapping. Scoped per handler so multiple handlers
  // (test isolation, multi-tenant) don't share identity state.
  const sessionIdentity = new Map();

  // Clean up identity map in lockstep with the session reaper. Check every
  // 60s — matches sessions.js reaper cadence. The short overlap window
  // (<60s) where sessionIdentity outlives sessions is harmless because POSTs
  // to a reaped session already 404 on sessions.has(id).
  const _identityCleanup = setInterval(() => {
    for (const id of sessionIdentity.keys()) {
      if (!hasSession(id)) sessionIdentity.delete(id);
    }
  }, 60_000);
  if (_identityCleanup.unref) _identityCleanup.unref();

  return async function handleMCP(req) {
    const url = new URL(req.url);
    const method = req.method;
    const sessionId = url.searchParams.get('sessionId');

    const mcpBaseIdentity = identifyAgent ? identifyAgent(req) : null;
    const mcpSessionHeader = req.headers.get('x-cortex-session');
    const mcpIdentity = (mcpBaseIdentity && mcpSessionHeader &&
      (mcpSessionHeader === mcpBaseIdentity || mcpSessionHeader.startsWith(mcpBaseIdentity + '-')))
      ? mcpSessionHeader
      : mcpBaseIdentity;

    if (method === 'POST' && url.pathname === '/mcp/message') {
      if (!sessionId || !hasSession(sessionId)) {
        return new Response(JSON.stringify({ error: 'Session not found' }), {
          status: 404, headers: { 'content-type': 'application/json' },
        });
      }
      if (!mcpIdentity) {
        return new Response(JSON.stringify({ error: 'unauthorized', message: 'valid X-Cortex-Token required' }), {
          status: 401, headers: { 'content-type': 'application/json' },
        });
      }
      const sessionAgent = sessionIdentity.get(sessionId);
      if (!sessionAgent) {
        return new Response(JSON.stringify({ error: 'forbidden', message: 'session has no bound identity' }), {
          status: 403, headers: { 'content-type': 'application/json' },
        });
      }
      if (mcpIdentity !== sessionAgent) {
        return new Response(JSON.stringify({ error: 'forbidden', message: 'session belongs to another agent' }), {
          status: 403, headers: { 'content-type': 'application/json' },
        });
      }
      const transport = getSession(sessionId);
      let body;
      try { body = await req.json(); } catch (err) {
        void err; // Rule 2.B — invalid JSON surfaced as 400 to client.
        return new Response('Invalid JSON', { status: 400 });
      }
      touchSession(sessionId);
      transport.onmessage?.(body);
      return new Response(null, { status: 202 });
    }

    if (method === 'GET') {
      if (!mcpIdentity) {
        return new Response(JSON.stringify({ error: 'unauthorized', message: 'valid X-Cortex-Token required' }), {
          status: 401, headers: { 'content-type': 'application/json' },
        });
      }
      if (sessions.size >= MAX_SESSIONS) {
        return new Response(JSON.stringify({
          error: 'too_many_sessions',
          message: `Server session limit (${MAX_SESSIONS}) reached. Try again later.`,
        }), {
          status: 503, headers: { 'content-type': 'application/json' },
        });
      }

      const id = crypto.randomUUID();
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const enc = new TextEncoder();

      const transport = new BunSSETransport(writer, id);
      // Loopback credential: prefer x-cortex-token, fall back to the
      // Authorization: Bearer token (the protocol prefers Bearer). Without the
      // fallback, a Bearer-authenticated MCP session opens but stores
      // agentToken=null, so its gatewayJson loopback calls go out
      // unauthenticated. Identity (mcpIdentity) is resolved
      // separately above and is unchanged.
      const mcpToken = req.headers.get('x-cortex-token')
        || req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
        || null;
      const sessionGateway = {
        ...gateway,
        config: { ...gateway.config, agentId: mcpIdentity, agentPlatform: mcpIdentity, agentToken: mcpToken },
      };
      const server = createCortexMCPServer(sessionGateway);
      await server.connect(transport);
      storeSession(id, transport);
      sessionIdentity.set(id, mcpIdentity);

      writer.write(enc.encode(`event: endpoint\ndata: /mcp/message?sessionId=${id}\n\n`));

      req.signal?.addEventListener('abort', () => {
        dropSession(id);
        sessionIdentity.delete(id);
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
