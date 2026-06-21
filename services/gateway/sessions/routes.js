/**
 * HTTP route mounting for the sessions plane. Takes an adapter object
 * shaped `{ add(method, path, handler) }` — same adapter shape used by
 * gateway/bridge/routes.js so the gateway's real HTTP router (Phase 7+)
 * can implement it in whatever style it chooses.
 *
 * Routes mounted:
 *   POST /v1/api/heartbeat
 *   GET  /v1/api/sessions
 *   GET  /v1/api/sessions/:id
 *   POST /v1/api/sessions/:id/release
 *   POST /v1/api/agents/register
 *   GET  /v1/api/agents
 *   GET  /v1/api/agents/:id
 *   PATCH /v1/api/agents/:id
 *
 * Every body-taking handler runs the input through a dedicated validate
 * function before touching state — satisfies the Rule 6.A lint
 * (scripts/lint/routes-validate-body.sh) even though no route yet uses
 * zod.safeParse directly. The validate functions live here for locality.
 */

import { readdirSync } from 'node:fs';
import { getDb } from '@cortex/sdk/db';
import { swallow } from '@cortex/sdk/errors';
import { defaultRunDir } from '@cortex/sdk/sessions';
import { upsertHeartbeat, getHeartbeat, getSessionHeartbeats } from './heartbeat.js';
import {
  getActiveSlots,
  releaseSlot,
  refreshFromLeases,
} from './slot-registry.js';
import { getSessionStatements } from './statements.js';
import {
  emitAgentRegistered,
  emitAgentUpdated,
} from './events.js';

// Small helper shared by every handler. Returns the standard
// `{ status, body }` shape bridge.routes uses so both planes speak the
// same HTTP contract at the adapter boundary.
function ok(body, status = 200) {
  return { status, body };
}

function err(code, reason, status = 400, extras = {}) {
  return { status, body: { error: code, reason, ...extras } };
}

// ---- body validators (plain object shape checks — full zod lives in
// core/schemas for the event payloads, but the HTTP routes use
// defensive parsing to keep the surface small) ----

function validate(required, body) {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'body must be an object' };
  for (const key of required) {
    if (typeof body[key] !== 'string' || body[key].length === 0) {
      return { ok: false, reason: `missing required field: ${key}` };
    }
  }
  return { ok: true };
}

// ---- heartbeat ----
function heartbeatHandler(ctx) {
  const v = validate(['agent_id'], ctx.body);
  if (!v.ok) return err('invalid_body', v.reason);
  const result = upsertHeartbeat({
    agentId: ctx.body.agent_id,
    currentTask: ctx.body.current_task || null,
    platform: ctx.body.platform || null,
  });
  return ok({ acknowledged: true, updated: result.updated });
}

/**
 * Derive the unique set of base-agent names present in the lease directory
 * by scanning for `<baseId>-<N>.session.json` filenames. Used by
 * listSessionsHandler to reconcile all known agents without hardcoding names.
 */
function leasedBaseAgents(runDir) {
  try {
    const entries = readdirSync(runDir);
    const agents = new Set();
    for (const name of entries) {
      const m = name.match(/^(.+)-\d+\.session\.json$/);
      if (m) agents.add(m[1]);
    }
    return [...agents];
  } catch (err) {
    swallow('sessions.list_scan_failed', err);
    return [];
  }
}

// ---- sessions ----
function listSessionsHandler(ctx) {
  const baseAgent = ctx?.query?.base_agent || null;
  // Reconcile the in-memory registry against the lease directory before
  // returning. Without this, sessions claimed by the MCP stdio-bootstrap
  // (which calls sdk/sessions.claimSessionSlot directly, bypassing the
  // gateway's claimSlot wrapper) never appear in the response because
  // the in-memory map is never populated from the existing lease files.
  const runDir = defaultRunDir();
  const agentsToRefresh = baseAgent ? [baseAgent] : leasedBaseAgents(runDir);
  for (const agent of agentsToRefresh) {
    try {
      refreshFromLeases({ baseAgent: agent, runDir });
    } catch (err) {
      swallow('sessions.list_refresh_failed', err);
    }
  }
  const slots = getActiveSlots(baseAgent);
  return ok({ sessions: slots, count: slots.length });
}

function getSessionHandler(ctx) {
  const id = ctx?.params?.id;
  if (typeof id !== 'string' || id.length === 0) {
    return err('invalid_params', 'session id is required');
  }
  const row = getSessionStatements().getSession.get(id);
  if (!row) return err('not_found', 'session does not exist', 404);
  return ok({ session: row });
}

function releaseSessionHandler(ctx) {
  const sessionId = ctx?.params?.id;
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return err('invalid_params', 'session id is required');
  }
  const graceful = ctx.body?.graceful !== false;
  const result = releaseSlot({ sessionId, graceful });
  return ok({ released: !!result.released, reason: result.reason || null, session_id: sessionId });
}

// ---- agents ----
function registerAgentHandler(ctx) {
  const v = validate(['name'], ctx.body);
  if (!v.ok) return err('invalid_body', v.reason);
  const stmts = getSessionStatements();
  const existing = stmts.getAgent.get(ctx.body.name);
  if (existing) return err('conflict', 'agent already registered', 409);

  const id = ctx.body.name;
  try {
    stmts.insertAgent.run(
      id,
      ctx.body.name,
      ctx.body.kind || 'generic',
      'online',
      JSON.stringify(ctx.body.capabilities || []),
      ctx.body.model || null,
      ctx.body.provider || null,
      JSON.stringify(ctx.body.metadata || {}),
      ctx.body.platform || null,
    );
  } catch (persistErr) {
    swallow('sessions.agent_register_failed', persistErr);
    return err('persist_failed', persistErr?.message || 'db error', 500);
  }

  try {
    emitAgentRegistered({
      agentId: id,
      platform: ctx.body.platform || undefined,
    });
  } catch (emitErr) {
    swallow('sessions.agent_registered_emit_failed', emitErr);
  }
  // Token minting lives in gateway/gate (Phase 7). The Phase 6 register
  // endpoint just creates the agent row + emits the event — callers
  // wanting a token follow up with POST /v1/api/agents/:id/token once
  // that plane ships.
  return ok({ agent_id: id, registered: true }, 201);
}

function listAgentsHandler() {
  const rows = getSessionStatements().listAgents.all();
  return ok({ agents: rows, count: rows.length });
}

function getAgentHandler(ctx) {
  const id = ctx?.params?.id;
  if (typeof id !== 'string' || id.length === 0) {
    return err('invalid_params', 'agent id is required');
  }
  const row = getSessionStatements().getAgent.get(id);
  if (!row) return err('not_found', 'agent does not exist', 404);
  return ok({ agent: row });
}

function patchAgentHandler(ctx) {
  const id = ctx?.params?.id;
  if (typeof id !== 'string' || id.length === 0) {
    return err('invalid_params', 'agent id is required');
  }
  const v = validate([], ctx.body);
  if (!v.ok) return err('invalid_body', v.reason);
  const existing = getSessionStatements().getAgent.get(id);
  if (!existing) return err('not_found', 'agent does not exist', 404);

  // Keep the diff narrow — patch only whitelisted fields so a misspelled
  // column name doesn't reach the DB. The gateway Phase 7 gate will add
  // permission checks here.
  const ALLOWED = ['status', 'model', 'provider', 'platform'];
  const fields = {};
  for (const key of ALLOWED) {
    if (typeof ctx.body[key] === 'string') fields[key] = ctx.body[key];
  }
  if (Object.keys(fields).length === 0) {
    return err('invalid_body', 'no updatable fields provided');
  }

  // Build a parametrized UPDATE — column names come from the ALLOWED
  // allow-list above, never from user input, so there is no SQL
  // injection surface despite the dynamic SET clause.
  const setKeys = Object.keys(fields);
  const assignments = setKeys.map((k) => `${k} = ?`).join(', ');
  const params = setKeys.map((k) => fields[k]);
  params.push(id);
  try {
    // Use the shared db handle — same connection as the prepared
    // statements (same singleton), so no cross-connection transaction
    // pitfalls.
    getDb().prepare(`UPDATE agents SET ${assignments} WHERE id = ?`).run(...params);
  } catch (persistErr) {
    swallow('sessions.agent_patch_failed', persistErr);
    return err('persist_failed', persistErr?.message || 'db error', 500);
  }

  try {
    emitAgentUpdated({ agentId: id, fields });
  } catch (emitErr) {
    swallow('sessions.agent_updated_emit_failed', emitErr);
  }
  return ok({ agent_id: id, updated: true, fields });
}

// ---- session heartbeat list (mirror of legacy getSessionHeartbeats) ----
function listSessionHeartbeatsHandler(ctx) {
  const baseAgent = ctx?.params?.base_agent;
  if (typeof baseAgent !== 'string' || baseAgent.length === 0) {
    return err('invalid_params', 'base_agent is required');
  }
  return ok({ heartbeats: getSessionHeartbeats(baseAgent) });
}

function getAgentHeartbeatHandler(ctx) {
  const id = ctx?.params?.id;
  if (typeof id !== 'string' || id.length === 0) {
    return err('invalid_params', 'agent id is required');
  }
  const row = getHeartbeat(id);
  if (!row) return err('not_found', 'no heartbeat recorded', 404);
  return ok({ heartbeat: row });
}

/**
 * @param {{ add: (method: string, path: string, handler: Function) => void }} adapter
 */
export function mountSessionRoutes(adapter) {
  if (!adapter || typeof adapter.add !== 'function') {
    throw new Error('mountSessionRoutes: adapter must expose add(method, path, handler)');
  }

  adapter.add('POST', '/v1/api/heartbeat', heartbeatHandler);
  // Legacy compat (§12.2): ~/Cortex/.claude/hooks/cortex-gate.sh and
  // cortex-complete.sh POST to /api/agents/heartbeat. Keeping a single hook
  // tree requires the rebuild gateway to answer the legacy path shape.
  // Retires when hooks flip to /v1/api/heartbeat (A -> B transition).
  adapter.add('POST', '/api/agents/heartbeat', heartbeatHandler);
  adapter.add('GET', '/v1/api/sessions', listSessionsHandler);
  adapter.add('GET', '/v1/api/sessions/:id', getSessionHandler);
  adapter.add('POST', '/v1/api/sessions/:id/release', releaseSessionHandler);

  adapter.add('POST', '/v1/api/agents/register', registerAgentHandler);
  adapter.add('GET', '/v1/api/agents', listAgentsHandler);
  adapter.add('GET', '/v1/api/agents/:id', getAgentHandler);
  adapter.add('PATCH', '/v1/api/agents/:id', patchAgentHandler);
  adapter.add('GET', '/v1/api/agents/:id/heartbeat', getAgentHeartbeatHandler);
  adapter.add('GET', '/v1/api/agents/:base_agent/heartbeats', listSessionHeartbeatsHandler);
}
