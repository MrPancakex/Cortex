/**
 * Minimal static-file server for the dashboard PWA bundle.
 *
 * Serves files from AGENTLINE_STATIC_DIR (the static build output directory).
 * Returns null when:
 *   - the env var is unset / dir does not exist (gateway runs without a PWA build)
 *   - the requested file is not found (caller should 404 or try index.html)
 *
 * MIME types are resolved from the file extension.
 * Only GET requests are served; other methods return null (fall through to 404).
 */

import path from 'node:path';
import { existsSync, statSync } from 'node:fs';

const MIME = {
  '.html':        'text/html; charset=utf-8',
  '.js':          'application/javascript; charset=utf-8',
  '.mjs':         'application/javascript; charset=utf-8',
  '.css':         'text/css; charset=utf-8',
  '.json':        'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg':         'image/svg+xml',
  '.png':         'image/png',
  '.ico':         'image/x-icon',
  '.woff2':       'font/woff2',
  '.woff':        'font/woff',
  '.txt':         'text/plain; charset=utf-8',
};

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

/**
 * Resolve the static dir. Returns null when the env var is absent.
 * Relative paths are resolved from process.cwd() (i.e. the gateway root).
 */
export function resolveStaticDir() {
  const raw = process.env.AGENTLINE_STATIC_DIR;
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

/**
 * Attempt to serve `pathname` from staticDir.
 *
 * Rules:
 *   1. Only GET method is served.
 *   2. Path traversal is rejected (resolved path must start with staticDir).
 *   3. If the exact file exists, serve it.
 *   4. If the path is '/' or ends with '/', try <path>/index.html.
 *   5. If neither exists, return null (caller returns a 404).
 *
 * @param {string} staticDir  Absolute path to the dist directory.
 * @param {string} pathname   URL pathname from the request.
 * @param {string} method     HTTP method string.
 * @returns {Response|null}
 */
export function serveStatic(staticDir, pathname, method) {
  if (method !== 'GET') return null;

  // Normalise: strip query-string fragments if any slip through.
  const clean = pathname.split('?')[0];

  // Resolve candidate paths; block path traversal.
  const candidates = [];
  const direct = path.resolve(staticDir, '.' + clean);
  // Only a real file under staticDir is a direct candidate. A bare '/'
  // resolves to staticDir itself (a directory) -- exclude it so the
  // index.html variant below is used instead of serving the dir.
  if (direct.startsWith(staticDir + path.sep)) {
    candidates.push(direct);
  }

  const indexVariant = path.resolve(staticDir, '.' + clean.replace(/\/?$/, '/index.html'));
  if (
    (indexVariant.startsWith(staticDir + path.sep) || indexVariant === staticDir) &&
    indexVariant !== direct
  ) {
    candidates.push(indexVariant);
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (statSync(candidate).isDirectory()) continue;
    const file = Bun.file(candidate);
    return new Response(file, {
      headers: { 'content-type': mimeFor(candidate) },
    });
  }

  return null;
}
