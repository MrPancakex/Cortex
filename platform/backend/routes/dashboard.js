/**
 * Dashboard static assets.
 *
 * The v0.1 backend mounted `platform/frontend/dist` under express.static.
 * The v0.2 rebuild doesn't ship the frontend bundle yet, but the backend
 * still needs to serve the built assets when one is present and to return
 * index.html for SPA routes that don't match an API path. Kept thin so the
 * frontend team can iterate on the bundle without touching the backend.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { swallow } from '@cortex/sdk/errors';
import { signToken, verifyToken, adminIdentity } from '@cortex/sdk/auth';

const SESSION_COOKIE = 'cortex_session';
const SESSION_TTL_MS = 86_400_000; // 24 h — matches Max-Age below

/**
 * Attempt to verify an existing session cookie. Returns true if valid.
 * Does NOT throw; all errors are swallowed so the handler can re-mint.
 */
async function isSessionValid(cookieHeader) {
  if (!cookieHeader) return false;
  const match = String(cookieHeader).split(';').find((p) => p.trimStart().startsWith(`${SESSION_COOKIE}=`));
  if (!match) return false;
  const token = match.split('=').slice(1).join('=').trim();
  if (!token) return false;
  try {
    await verifyToken(token);
    return true;
  } catch (err) {
    swallow('platform.session_verify_failed', err);
    return false;
  }
}

/**
 * Mint a new session cookie string. Returns null on any error so the caller
 * can degrade to serving the file without a cookie.
 */
function mintSessionCookie() {
  try {
    const token = signToken({ ...adminIdentity() }, { ttlMs: SESSION_TTL_MS });
    return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;
  } catch (err) {
    swallow('platform.session_mint_failed', err);
    return null;
  }
}

const ROUTE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIST = path.resolve(ROUTE_DIR, '../../frontend/dist');
const DEFAULT_SOURCE_ROOT = path.resolve(ROUTE_DIR, '../../frontend');
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
});

function contentTypeFor(ext) {
  return MIME[ext.toLowerCase()] || 'application/octet-stream';
}

function resolveSafe(root, requested) {
  // Strip leading slash and query; normalize; then confirm the resolved
  // path is still inside the root. This blocks `/..` traversal.
  const clean = decodeURIComponent(requested.split('?')[0] || '').replace(/^\/+/, '');
  const resolved = path.resolve(root, clean);
  const rootResolved = path.resolve(root) + path.sep;
  if (!resolved.startsWith(rootResolved) && resolved !== path.resolve(root)) return null;
  return resolved;
}

function streamFile(res, filePath) {
  const ext = path.extname(filePath);
  res.setHeader('content-type', contentTypeFor(ext));
  const stream = fs.createReadStream(filePath);
  stream.on('error', (err) => {
    swallow('platform.dashboard_stream_failed', err);
    if (!res.headersSent) res.statusCode = 500;
    try { res.end(); } catch (closeErr) { swallow('platform.dashboard_close_failed', closeErr); }
  });
  stream.pipe(res);
}

function resolveDashboardRoot(distRoot) {
  if (distRoot === DEFAULT_DIST && !fs.existsSync(path.join(distRoot, 'index.html'))) {
    const sourceIndex = path.join(DEFAULT_SOURCE_ROOT, 'index.html');
    if (fs.existsSync(sourceIndex)) return DEFAULT_SOURCE_ROOT;
  }
  return distRoot;
}

/**
 * Create a handler that serves static files from `distRoot` and falls back
 * to `index.html` for any path that doesn't resolve to a file (SPA mode).
 *
 * Returns a fallback handler — the caller decides whether to mount it as a
 * catch-all GET or only after API routes.
 */
export function createDashboardHandler({ distRoot = DEFAULT_DIST } = {}) {
  return async function dashboard(ctx) {
    const { req, res } = ctx;
    const dashboardRoot = resolveDashboardRoot(distRoot);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('allow', 'GET, HEAD');
      res.end();
      return;
    }

    // Never intercept API paths here — those are mounted by other routers.
    if (req.path?.startsWith('/api/')) {
      res.statusCode = 404;
      res.end();
      return;
    }

    const resolved = resolveSafe(dashboardRoot, req.path || '/');
    if (!resolved) {
      res.statusCode = 400;
      res.end();
      return;
    }
    const candidate = (req.path === '/' || req.path === '')
      ? path.join(dashboardRoot, 'index.html')
      : resolved;

    // Mint or revalidate the session cookie before any headers are sent.
    // Only set Set-Cookie on HTML responses (SPA shell + SPA fallback) to
    // avoid touching asset responses. We check validity first to avoid
    // thrashing the cookie on every JS/CSS fetch the SPA makes.
    const isHtml = (filePath) => path.extname(filePath).toLowerCase() === '.html' || filePath === path.join(dashboardRoot, 'index.html');
    const sessionValid = await isSessionValid(req.headers?.cookie);
    const setCookieForHtml = (filePath) => {
      if (!sessionValid && isHtml(filePath)) {
        const cookie = mintSessionCookie();
        if (cookie) res.setHeader('set-cookie', cookie);
      }
    };

    fs.stat(candidate, (err, stat) => {
      if (err || !stat.isFile()) {
        // SPA fallback: serve index.html if it exists.
        const indexFile = path.join(dashboardRoot, 'index.html');
        fs.stat(indexFile, (err2, stat2) => {
          if (err2 || !stat2.isFile()) {
            res.statusCode = 404;
            res.end();
            return;
          }
          setCookieForHtml(indexFile);
          streamFile(res, indexFile);
        });
        return;
      }
      setCookieForHtml(candidate);
      streamFile(res, candidate);
    });
  };
}

/**
 * Mount helper consistent with the adapter contract used elsewhere in the
 * platform backend. Register a single wildcard GET handler under '/' — the
 * router dispatch logic is expected to try specific routes first.
 */
export function mountDashboardRoutes(adapter, opts = {}) {
  if (!adapter || typeof adapter.add !== 'function') {
    throw new Error('mountDashboardRoutes: adapter must expose add(method, path, handler)');
  }
  const handler = createDashboardHandler(opts);
  adapter.add('GET', '*', handler);
  adapter.add('HEAD', '*', handler);
}

export { DEFAULT_DIST };
