/**
 * agent-context.js — canonical read-path for `gateway.config.agentId`.
 * Lifted from services/gateway/lib per Rule 1 (downward-only dependency):
 * reads the configured token / resolves session identity, and is consumed
 * by both gateway tool handlers AND the session hooks layer, so it
 * belongs in sdk/auth/ rather than inside the gateway service.
 *
 * Shape is deliberately minimal:
 *   - getAgentId(gateway) → string | null
 *   - mustGetAgentId(gateway) → string (throws 400 when unset)
 *   - getAgentPlatform(gateway) → string (defaults to agentId)
 *   - agentContext(gateway) → { agentId, platform } convenience bundle
 */

export function getAgentId(gateway) {
  return gateway?.config?.agentId || null;
}

export function mustGetAgentId(gateway) {
  const id = getAgentId(gateway);
  if (!id) {
    const err = new Error('agent_id not configured — set CORTEX_AGENT_ID');
    err.statusCode = 400;
    throw err;
  }
  return id;
}

export function getAgentPlatform(gateway) {
  return gateway?.config?.agentPlatform || getAgentId(gateway);
}

export function agentContext(gateway) {
  const agentId = mustGetAgentId(gateway);
  return { agentId, platform: getAgentPlatform(gateway) };
}
