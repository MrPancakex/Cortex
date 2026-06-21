/**
 * Cortex gateway process entrypoint — PUBLIC (lean) variant.
 *
 * Carved from server.js for the public skeleton (Plan E Part C):
 *   - DROPS the bridge plane: no createWakeupSender / bridge/wakeup-sender import,
 *     no `bridge: { sendFn }` option passed to composePublicGateway.
 *   - DROPS the proxy short-circuit: no isProxyRoute / handleProxy calls.
 *     The public skeleton has no proxy/providers plane.
 *   - KEEPS static-serve (dashboard), composePublicGateway (the lean composer),
 *     isMCPRoute, migrations, the Unix admin socket, and the full listen flow.
 *
 * The export pipeline (Plan E) renames this file to server.js in the staged
 * tree so the acceptance gate boots via `bun services/gateway/server.js`.
 */

import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GATEWAY_PORT } from '@cortex/core/constants';
import { swallow } from '@cortex/sdk/errors';
import { getDb, runMigrations } from '@cortex/sdk/db';
import { composePublicGateway, isMCPRoute } from './composer.js';
import { resolveSubject, reconcilePathIdentity } from './gate/index.js';
import { evaluateApiMutation } from './auth/index.js';
import { resolveStaticDir, serveStatic } from './static-serve.js';

function matchPath(pattern, actual) {
  const pSeg = pattern.split('/');
  const aSeg = actual.split('/');
  if (pSeg.length !== aSeg.length) return null;
  const params = {};
  for (let i = 0; i < pSeg.length; i += 1) {
    if (pSeg[i].startsWith(':')) {
      params[pSeg[i].slice(1)] = decodeURIComponent(aSeg[i]);
    } else if (pSeg[i] !== aSeg[i]) {
      return null;
    }
  }
  return params;
}

/**
 * Build an adapter whose `add()` records routes and whose `dispatch()`
 * resolves an incoming Request to the matching handler + params.
 */
export function createBunAdapter() {
  const routes = [];
  return {
    routes,
    add(method, pattern, handler) {
      routes.push({ method, pattern, handler });
    },
    async dispatch(req, overrides = {}) {
      const url = new URL(req.url);
      const method = req.method.toUpperCase();
      for (const r of routes) {
        if (r.method !== method) continue;
        const params = matchPath(r.pattern, url.pathname);
        if (params == null) continue;

        const pathAgentId = extractPathAgentIdFromPattern(r.pattern, params);
        const auth = buildAuthContext(req, overrides, pathAgentId, method);
        if (auth.status) return auth; // path-identity reconciliation / anon-mutation

        const query = Object.fromEntries(url.searchParams);
        let body = null;
        let bodyParseErr = null;
        if (method !== 'GET' && method !== 'HEAD') {
          try {
            const text = await req.text();
            if (text) body = JSON.parse(text);
          } catch (err) {
            const ct = req.headers.get('content-type') || 'unknown';
            swallow(`gateway.server_body_parse_failed.${sanitizeMetric(ct)}`, err);
            bodyParseErr = err;
          }
        }
        if (bodyParseErr) {
          return { status: 400, body: { error: 'invalid_json_body', reason: bodyParseErr.message } };
        }

        if (MUTATING_METHODS.has(method) && !auth.isAdmin) {
          const scope = auth.actor?.scope ?? auth.subject?.scope ?? 'anon';
          const decision = evaluateApiMutation({ scope });
          if (!decision.allowed) {
            const status = decision.reason === 'matrix_unavailable' ? 503 : 403;
            return {
              status,
              body: {
                error: status === 503 ? 'service_unavailable' : 'forbidden',
                reason: decision.reason,
                scope: decision.scope,
              },
            };
          }
        }

        return r.handler({
          params,
          query,
          body,
          req,
          headers: req.headers,
          actor: auth.actor,
          isAdmin: auth.isAdmin,
          platform: auth.platform,
          subject: auth.subject,
          isAdminSocket: Boolean(overrides.isAdminSocket),
          channel: overrides.isAdminSocket ? 'unix' : 'tcp',
        });
      }
      return { status: 404, body: { error: 'no_route', path: url.pathname } };
    },
  };
}

function extractPathAgentIdFromPattern(pattern, params) {
  const segs = pattern.split('/');
  for (let i = segs.length - 2; i >= 0; i -= 1) {
    if (segs[i] !== 'agents') continue;
    const next = segs[i + 1];
    if (!next || !next.startsWith(':')) return null;
    const paramName = next.slice(1);
    const value = params[paramName];
    if (typeof value === 'string' && value.length > 0) return value;
    return null;
  }
  return null;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

function buildAuthContext(req, overrides, pathAgentId, method) {
  if (overrides.actor) {
    const actor = overrides.actor;
    const overrideSubject = overrides.subject
      ?? (actor.kind ? actor : { kind: 'agent', id: actor.id, base: actor.base });
    if (pathAgentId && overrideSubject.kind !== 'anon'
      && !reconcilePathIdentity(pathAgentId, overrideSubject)) {
      return {
        status: 403,
        body: {
          error: 'forbidden',
          reason: 'path identity does not match authenticated caller',
        },
      };
    }
    return {
      actor,
      isAdmin: Boolean(overrides.isAdmin ?? actor.admin ?? actor.kind === 'admin'),
      platform: overrides.platform ?? actor.platform ?? null,
      subject: overrides.subject ?? null,
    };
  }

  const subject = resolveSubject({ headers: req.headers });
  const isAnon = subject.kind === 'anon';
  const isSafe = SAFE_METHODS.has(method);

  if (isAnon && subject.reason === 'auth_error') {
    return {
      status: 503,
      body: { error: 'service_unavailable', reason: 'auth_resolution_failed' },
    };
  }

  if (isAnon && subject.reason === 'uid_bearer_mismatch') {
    return {
      status: 401,
      body: { error: 'unauthorized', reason: 'uid_bearer_mismatch' },
    };
  }

  if (pathAgentId && isAnon && !isSafe) {
    return {
      status: 401,
      body: {
        error: 'unauthorized',
        reason: 'authentication required for agent-scoped mutations',
      },
    };
  }

  if (pathAgentId && !isAnon && !reconcilePathIdentity(pathAgentId, subject)) {
    return {
      status: 403,
      body: {
        error: 'forbidden',
        reason: 'path identity does not match authenticated caller',
      },
    };
  }

  if (subject.kind === 'admin' && !overrides.isAdminSocket) {
    return {
      status: 403,
      body: {
        error: 'admin_scope_requires_unix_socket',
        reason: 'use ~/.cortex/admin.sock',
      },
    };
  }

  if (isAnon) {
    return {
      actor: { kind: 'anon' },
      isAdmin: false,
      platform: null,
      subject,
    };
  }
  const actor = {
    id: subject.id,
    base: subject.base,
    scope: subject.scope ?? subject.base ?? 'anon',
    role: subject.role,
    platform: subject.platform,
    kind: subject.kind,
    admin: subject.kind === 'admin',
  };
  return {
    actor,
    isAdmin: subject.kind === 'admin',
    platform: subject.platform ?? null,
    subject,
  };
}

function sanitizeMetric(input) {
  return String(input)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .slice(0, 32);
}

/**
 * Inject a bearer token from the `?token=` query param when the request targets
 * the events/stream WS endpoint and carries no existing auth header.
 */
export function injectBearerFromQuery(req, url) {
  if (url.pathname !== '/v1/api/events/stream') return req;
  const tokenParam = url.searchParams.get('token');
  const hasAuthHeader = Boolean(
    req.headers.get('authorization') || req.headers.get('x-cortex-token'),
  );
  if (!tokenParam || hasAuthHeader) return req;
  const newHeaders = new Headers(req.headers);
  newHeaders.set('authorization', `Bearer ${tokenParam}`);
  return new Request(req.url, { method: req.method, headers: newHeaders, body: req.body });
}

const wsBindings = new WeakMap();

const sharedWebsocket = {
  open(ws) {
    const data = ws.data;
    if (!data || typeof data.createHandlerPair !== 'function') return;
    const pair = data.createHandlerPair(ws);
    wsBindings.set(ws, pair);
    try {
      pair.onOpen();
    } catch (err) {
      swallow('gateway.server_ws_open_failed', err);
    }
  },
  close(ws) {
    const pair = wsBindings.get(ws);
    if (!pair) return;
    try {
      pair.onClose();
    } catch (err) {
      swallow('gateway.server_ws_close_failed', err);
    }
    wsBindings.delete(ws);
  },
  message(ws, data) {
    swallow(
      'gateway.server_ws_unexpected_message',
      new Error(`inbound message on subscribe-only stream (${typeof data})`),
    );
  },
};

/**
 * Default admin-socket path — homedir-derived (`~/.cortex/admin.sock`),
 * overridable via `CORTEX_ADMIN_SOCKET`. No hardcoded operator path.
 */
export function defaultAdminSocket() {
  return process.env.CORTEX_ADMIN_SOCKET || path.join(os.homedir(), '.cortex', 'admin.sock');
}

/**
 * Start the gateway server (public/lean variant — no bridge, no proxy).
 *
 * Returns `{ server, unixServer, adapter, boot }`.
 */
export async function startGatewayServer({
  port = GATEWAY_PORT,
  hostname = process.env.CORTEX_GATEWAY_HOST || process.env.HOST || '127.0.0.1',
  drainRecovery = true,
  installProcessHandlers = true,
  unixSocket = defaultAdminSocket(),
} = {}) {
  getDb();
  runMigrations();

  const adapter = createBunAdapter();
  const boot = await composePublicGateway(adapter, {
    drainRecovery,
    installProcessHandlers,
  });

  const server = Bun.serve({
    hostname,
    port,
    async fetch(req, srv) {
      const url = new URL(req.url);

      // MCP short-circuit — SSE streams and session-scoped POSTs need the
      // raw Request/Response pair; adapter.dispatch serializes as JSON.
      if (isMCPRoute(url.pathname) && boot.mcpHandler) {
        try {
          return await boot.mcpHandler(req);
        } catch (err) {
          swallow('gateway.server_mcp_failed', err);
          return new Response(
            JSON.stringify({ error: 'mcp_failed', reason: err?.message || 'mcp error' }),
            { status: 500, headers: { 'content-type': 'application/json' } },
          );
        }
      }

      const result = await adapter.dispatch(injectBearerFromQuery(req, url), { isAdminSocket: false });
      if (result?.upgrade && typeof result.upgrade === 'object') {
        const upgraded = srv.upgrade(req, { data: result.upgrade });
        if (upgraded) return undefined;
        return new Response(
          JSON.stringify({ error: 'upgrade_refused', reason: 'ws handshake invalid' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      const status = result?.status ?? 200;
      const body = result?.body ?? {};
      if (status === 404) {
        const staticDir = resolveStaticDir();
        if (staticDir) {
          const staticResp = serveStatic(staticDir, url.pathname, req.method);
          if (staticResp) return staticResp;
        }
      }
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    },
    websocket: sharedWebsocket,
  });

  let unixServer = null;
  if (unixSocket) {
    try {
      unlinkSync(unixSocket);
    } catch {
      // Socket file not present — that's fine.
    }
    const oldUmask = process.umask(0o177);
    try {
      unixServer = Bun.serve({
        unix: unixSocket,
        async fetch(req, srv) {
          const url = new URL(req.url);
          if (isMCPRoute(url.pathname) && boot.mcpHandler) {
            try {
              return await boot.mcpHandler(req);
            } catch (err) {
              swallow('gateway.unix_mcp_failed', err);
              return new Response(
                JSON.stringify({ error: 'mcp_failed', reason: err?.message || 'mcp error' }),
                { status: 500, headers: { 'content-type': 'application/json' } },
              );
            }
          }
          const result = await adapter.dispatch(injectBearerFromQuery(req, url), { isAdminSocket: true });
          if (result?.upgrade && typeof result.upgrade === 'object') {
            const upgraded = srv.upgrade(req, { data: result.upgrade });
            if (upgraded) return undefined;
            return new Response(
              JSON.stringify({ error: 'upgrade_refused', reason: 'ws handshake invalid' }),
              { status: 400, headers: { 'content-type': 'application/json' } },
            );
          }
          const status = result?.status ?? 200;
          const body = result?.body ?? {};
          return new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          });
        },
        websocket: sharedWebsocket,
      });
    } finally {
      process.umask(oldUmask);
    }
  }

  return { server, unixServer, adapter, boot };
}

// Auto-start when executed directly via `bun services/gateway/server.js`.
if (import.meta.main) {
  startGatewayServer().then(
    ({ server, unixServer, boot }) => {
      process.stdout.write(
        `cortex-gateway listening on ${server.hostname || '127.0.0.1'}:${server.port}, recovery=${JSON.stringify(boot.recovery)}\n`,
      );
      if (unixServer) {
        process.stdout.write(
          `cortex-gateway unix socket: ${defaultAdminSocket()} (mode 0600)\n`,
        );
      }
    },
    (err) => {
      swallow('gateway.startup_failed', err);
      process.exit(1);
    },
  );
}
