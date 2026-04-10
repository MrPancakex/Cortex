/**
 * Agent identity — token validation, registry management, hot-reload.
 *
 * Identity is derived SERVER-SIDE from the token hash. Never trust headers.
 * Token registry is a JSON file at $CORTEX_TOKEN_REGISTRY.
 *
 * Registry format:
 * {
 *   "agents": {
 *     "my-agent": { "hash": "sha256hex", "created": "iso", "platform": "my-agent" },
 *     "admin":    { "hash": "sha256hex", "created": "iso", "role": "admin" }
 *   }
 * }
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, watch } from 'node:fs';
import { join } from 'node:path';

const REGISTRY_PATH = process.env.CORTEX_TOKEN_REGISTRY
  || join(process.env.HOME || '', '.cortex', 'data', 'token-registry.json');

let _registry = { agents: {} };

/**
 * Load the token registry from disk.
 */
function loadRegistry() {
  try {
    const data = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
    if (data && typeof data.agents === 'object') {
      _registry = data;
      console.log(`[auth] Token registry loaded: ${Object.keys(_registry.agents).length} agents`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[auth] Failed to load token registry: ${err.message}`);
    }
    // Keep existing registry on error — don't wipe on transient failure
  }
}

/**
 * Initialize the auth module — load registry, set up hot-reload.
 */
export function initAuth() {
  loadRegistry();

  // Watch for file changes
  try {
    watch(REGISTRY_PATH, (eventType) => {
      if (eventType === 'change') {
        loadRegistry();
      }
    });
  } catch {
    // File may not exist yet — that's OK, SIGHUP will reload
  }

  // SIGHUP reload (from systemctl reload)
  process.on('SIGHUP', () => {
    loadRegistry();
    console.log('[auth] Token registry reloaded (SIGHUP)');
  });
}

/**
 * Hash a raw token with SHA-256.
 */
function hashToken(raw) {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Identify an agent from the request. Returns the agent name or null.
 * Identity is derived from the token hash — NEVER from headers or URL path.
 */
export function identifyAgent(req) {
  const token = req.headers.get('x-cortex-token');
  if (!token) return null;
  // Reject duplicate/joined tokens (Bun joins duplicate headers with ", ")
  if (token.includes(',')) return null;

  const hash = hashToken(token);

  const hashBuf = Buffer.from(hash, 'hex');
  for (const [agent, config] of Object.entries(_registry.agents)) {
    const storedBuf = Buffer.from(config.hash, 'hex');
    // Both are SHA-256 hex digests so lengths are always 32 bytes.
    // Guard anyway — timingSafeEqual throws on length mismatch.
    if (hashBuf.length === storedBuf.length && timingSafeEqual(hashBuf, storedBuf)) {
      return agent;
    }
  }

  return null;
}

/**
 * Check if the request is from an admin (for unscoped endpoints).
 * In Phase 1, admin is identified by a special admin token in the registry.
 */
export function isAdmin(agentIdentity) {
  if (!agentIdentity) return false;
  const config = _registry.agents[agentIdentity];
  return config && config.role === 'admin';
}

/**
 * Auth middleware result — attaches identity to context.
 * Returns { identity, error } where identity is agent name or null.
 */
export function authenticateRequest(req) {
  const token = req.headers.get('x-cortex-token');

  // No token = unauthenticated
  if (!token) {
    return { identity: null, error: 'missing X-Cortex-Token header' };
  }

  const identity = identifyAgent(req);
  if (!identity) {
    return { identity: null, error: 'invalid token' };
  }

  return { identity, error: null };
}

/**
 * Validate that path agent ID matches token identity.
 * If path says atlas but token maps to gerald → reject. */
export function reconcilePathIdentity(pathAgentId, tokenIdentity) {
  if (!pathAgentId) return true;  // No path prefix — no conflict
  if (!tokenIdentity) return false;  // Path prefix but no identity — reject
  return pathAgentId === tokenIdentity;
}

/**
 * Check if a route requires authentication.
 * Health, proxy routes (which have their own provider auth), and the base path don't need cortex tokens.
 */
export function requiresAuth(pathname, method) {
  // Health check — always public
  if (pathname === '/health') return false;

  // Proxy routes use provider auth, not cortex tokens
  // But we still identify the agent for logging if a token is present
  if ((pathname.startsWith('/v1/') && pathname !== '/v1/logs') || pathname.startsWith('/api/chat') ||
      pathname.startsWith('/api/generate') || pathname.startsWith('/api/tags') ||
      pathname.startsWith('/openrouter/') || pathname.match(/^\/agent\/[^/]+\/v1\//)) {
    return false;
  }

  // MCP — requires auth same as other API routes

  // WebSocket upgrade — requires auth (token in query param)
  // if (pathname === '/ws/gateway') return false;

  // Everything else (API routes) requires auth
  return true;
}

/**
 * Get the current registry (for CLI/admin use).
 */
export function getRegistry() {
  return _registry;
}

export { hashToken, loadRegistry };
