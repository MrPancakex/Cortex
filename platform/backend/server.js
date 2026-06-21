/**
 * Cortex platform backend — entry point.
 *
 * Phase 10 re-point: the v0.1 dashboard backend ran a 228-line reverse proxy.
 * The v0.2 backend is a thin router that composes @cortex/core +
 * @cortex/sdk + the gateway sub-plane barrels through a single client.
 *
 * Responsibilities:
 *   - Enforce loopback-only binding (single-host, single-user deployment).
 *   - Host platform-owned routes: /api/system/*.
 *   - Forward /api/* to the gateway via `gateway-client`.
 *   - Serve the frontend bundle (SPA fallback to index.html).
 *
 * Not responsibilities:
 *   - Auth state. The SDK owns it.
 *   - DB handles. The gateway owns them.
 *   - WebSocket fan-out. The gateway hosts the socket transport; the
 *     frontend points its WS client directly at the gateway.
 */
import http from 'node:http';
import {
  createLogger,
  rootLogger,
  setRootLogger,
} from '@cortex/sdk/logging';
import { swallow } from '@cortex/sdk/errors';
import { loadConfig } from './lib/config.js';
import { createGatewayClient } from './lib/gateway-client.js';
import { assertLoopbackBinding, requireLoopback, platformAuth } from './middleware/auth.js';
import { platformCors } from './middleware/cors.js';
import { mountSystemRoutes } from './routes/system.js';
import { mountGatewayProxyRoutes } from './routes/gateway-proxy.js';
import { mountDashboardRoutes } from './routes/dashboard.js';

const HOST = process.env.PLATFORM_HOST || '127.0.0.1';
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'];

function compilePattern(pattern) {
  if (pattern === '*') return { regex: /^.+$/, keys: [] };
  const keys = [];
  const source = pattern.replace(/:[A-Za-z0-9_]+/g, (m) => {
    keys.push(m.slice(1));
    return '([^/]+)';
  });
  return { regex: new RegExp(`^${source}$`), keys };
}

async function readJsonBodyIfNeeded(req) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') return null;
  const chunks = [];
  await new Promise((resolve, reject) => {
    req.on('data', (c) => chunks.push(c));
    req.on('end', resolve);
    req.on('error', reject);
  });
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    swallow('platform.body_parse_failed', err);
    const parseErr = new Error('invalid json');
    parseErr.statusCode = 400;
    throw parseErr;
  }
}

/**
 * Tiny express-ish router so the server stays under the size ceiling
 * without pulling in express. The shape intentionally matches the
 * `adapter.add(method, path, handler)` contract each gateway plane uses,
 * so mounting helpers written for the gateway can target the platform
 * router too.
 */
export function createRouter() {
  const middlewares = [];
  const routes = [];

  const api = {
    use(mw) { middlewares.push(mw); return api; },
    add(method, pattern, handler) {
      routes.push({ method: method.toUpperCase(), ...compilePattern(pattern), pattern, handler });
      return api;
    },
    async handle(req, res) {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      req.path = url.pathname;
      req.query = Object.fromEntries(url.searchParams.entries());

      let i = 0;
      const next = async (err) => {
        if (err) {
          swallow('platform.router_middleware_failed', err);
          if (!res.headersSent) {
            res.statusCode = err.statusCode || 500;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.end(JSON.stringify({ error: 'server_error', message: err.message }));
          }
          return;
        }
        if (i < middlewares.length) {
          const mw = middlewares[i++];
          try {
            await mw(req, res, next);
          } catch (mwErr) {
            next(mwErr);
          }
          return;
        }

        let star = null;
        for (const route of routes) {
          if (route.method !== req.method) continue;
          const m = route.regex.exec(req.path);
          if (!m) continue;
          if (route.pattern === '*') {
            if (!star) star = { route, match: m };
            continue;
          }
          const params = {};
          for (let k = 0; k < route.keys.length; k += 1) {
            params[route.keys[k]] = decodeURIComponent(m[k + 1] || '');
          }
          try {
            const body = await readJsonBodyIfNeeded(req);
            await route.handler({ req, res, params, query: req.query, body, actor: req.auth || null });
          } catch (handlerErr) {
            next(handlerErr);
          }
          return;
        }
        if (star) {
          try {
            await star.route.handler({ req, res, params: {}, query: req.query, body: null, actor: req.auth || null });
          } catch (starErr) {
            next(starErr);
          }
          return;
        }
        if (!res.headersSent) {
          res.statusCode = 404;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: 'not_found' }));
        }
      };
      await next();
    },
  };
  return api;
}

/**
 * Build a fully-wired router. Exported so tests can drive the whole
 * surface without spinning up an actual http.Server.
 */
export function createApp({
  config = loadConfig(),
  gateway = createGatewayClient({ baseUrl: config.gateway.url }),
  logger = null,
} = {}) {
  const log = logger || createLogger({ resource: { service_name: 'cortex-platform' } });
  setRootLogger(log);

  const router = createRouter();
  router.use(platformCors());
  router.use(requireLoopback);
  router.use(async (req, res, next) => {
    if (req.method === 'GET' && req.path === '/health') {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ status: 'ok', service: 'cortex-platform' }));
      return;
    }
    if (req.path?.startsWith('/api/')) return platformAuth(req, res, next);
    return next();
  });

  mountSystemRoutes(router, { gateway });
  mountGatewayProxyRoutes(router, { gateway });
  mountDashboardRoutes(router);

  return { router, config, gateway, log };
}

export async function startServer({ host = HOST, port } = {}) {
  assertLoopbackBinding(host);
  const { router, config, log } = createApp();
  const listenPort = port || config.ports.backend;
  const server = http.createServer((req, res) => router.handle(req, res));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  log.info({ host, port: listenPort }, 'platform backend listening');

  for (const sig of SHUTDOWN_SIGNALS) {
    process.on(sig, () => {
      log.info({ sig }, 'shutting down platform');
      server.close((err) => {
        if (err) swallow('platform.shutdown_failed', err);
      });
      setTimeout(() => process.exit(0), 5_000).unref();
    });
  }

  return server;
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  (typeof process.argv[1] === 'string' && process.argv[1].endsWith('platform/backend/server.js'));

if (invokedDirectly) {
  startServer().catch((err) => {
    rootLogger.fatal({ err: err.message }, 'platform boot failed');
    process.exit(1);
  });
}
