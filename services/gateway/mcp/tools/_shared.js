// Per-tool files keep their own bodies small by re-using these helpers.
import { gatewayFetch, GatewayError } from '../../../../sdk/http/client.js';

export function route(gateway, name, { params = {}, query = null } = {}) {
  const routes = gateway?.config?.routes;
  if (!routes || typeof routes !== 'object') {
    throw new Error('route_manifest_missing');
  }
  const entry = routes[name];
  if (!entry?.path) {
    throw new Error(`unknown_tool_route:${name}`);
  }
  let path = entry.path;
  for (const [key, value] of Object.entries(params || {})) {
    if (value === null || value === undefined) continue;
    path = path.replace(`:${key}`, encodeURIComponent(String(value)));
  }
  const search = query instanceof URLSearchParams
    ? query
    : new URLSearchParams();
  if (query && !(query instanceof URLSearchParams)) {
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined) continue;
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

export async function gatewayJson(gateway, path, init = {}) {
  const url = `${gateway.config.gatewayUrl}${path}`;
  const { method = 'GET', body, headers: extraHeaders } = init;
  try {
    return await gatewayFetch(url, {
      token: gateway.config.agentToken || undefined,
      agentId: gateway.config.agentId || undefined,
      method,
      body,
      headers: extraHeaders,
    });
  } catch (err) {
    if (err instanceof GatewayError) {
      throw new Error(err.message);
    }
    // Network error (ECONNREFUSED etc.)
    throw new Error(`Gateway unreachable: ${err.message}`);
  }
}

export async function gatewayJsonRaw(gateway, path, init = {}) {
  const url = `${gateway.config.gatewayUrl}${path}`;
  const { method = 'GET', body, headers: extraHeaders } = init;
  try {
    const responseBody = await gatewayFetch(url, {
      token: gateway.config.agentToken || undefined,
      agentId: gateway.config.agentId || undefined,
      method,
      body,
      headers: extraHeaders,
    });
    return { status: 200, body: responseBody };
  } catch (err) {
    if (err instanceof GatewayError) {
      return { status: err.status, body: err.body ?? { error: err.message } };
    }
    throw new Error(`Gateway unreachable: ${err.message}`);
  }
}

export { syncCurrentTaskFile, clearCurrentTaskFile, persistTaskState } from '../_task-files.js';

/**
 * Build a deterministic `not_implemented` response for tool handlers
 * whose backing HTTP route is not mounted in the rebuild yet. Gives
 * operators a structured error they can match on rather than an opaque
 * 404 surfaced from gatewayJson. `reason` names the missing route;
 * `tracking` points at the plan section that will land it.
 */
export function notImplementedStub({ reason, tracking, detail }) {
  return Object.freeze({
    ok: false,
    error: 'not_implemented',
    reason,
    tracking,
    detail,
    by_design: true,
  });
}

/**
 * Slim a mutation tool response down to the essential fields:
 *   { task_id, id, status, <changed fields...>, next_step_hint }
 *
 * Strips the full nested arrays (journal, comments, progress_reports,
 * description) from mutation responses — the agent already knows what
 * it just mutated and does not need the full task serialised back.
 * Pass `extra` for directly-changed fields that should be included
 * (e.g. { assigned_to, reviewer_agent } for claim_task).
 *
 * IDENTIFIER NORMALISATION: real HTTP routes return the task identifier as
 * either `id` (claim_task, task_update) or `task_id` (submit_result,
 * report_progress, request_verification, task_reopen).  The gate checks
 * both so responses using the task_id key are not passed through unchanged.
 *
 * If the response has neither `id` nor `task_id` (error or non-task shape),
 * it is returned as-is so error paths pass through unchanged.
 *
 * HINT KEY: real routes emit `next_step_hint` via hint() in _internals.js.
 * `__hint` is kept as a compatibility fallback (test harness + old shapes).
 *
 * PASSTHROUGH FIELDS (contract R2 — operational passthrough rule):
 *   - _subagent_event_id: dashboard agent-lifecycle tracking; set by claim_task
 *     after registerTaskWorker(); must round-trip to caller so the caller can
 *     correlate its own event id with the claim response.
 *   - local_state: annotation written by persistTaskState (test harness + dashboard compat).
 *   - warning: non-fatal notice from the gateway or local state write.
 *
 * RENAME: `id` is preserved as BOTH `id` and `task_id` for backward
 * compatibility — the mcp-claim-submit-integration test (a real consumer)
 * asserts `result.id`; `task_id` is the preferred name going forward.
 * Both are included so existing callers are not broken.
 */
export function slimMutationResponse(response, extra = {}) {
  if (!response || typeof response !== 'object') return response;
  // Normalise: routes use either 'id' or 'task_id' as the identifier key.
  const identifier = response.id ?? response.task_id;
  if (!identifier) return response;
  const slim = {
    task_id: identifier,
    id: identifier,   // backward-compat — real consumer (mcp-claim-submit-integration) asserts .id
  };
  // Guard optional fields: only set the key when the value is defined so that
  // absent values produce NO key (not an undefined-valued key). A `status: undefined`
  // present key can re-trip validation findings. Contract note (e): task_update
  // is explicitly exempt from status — this guard makes the object match that contract.
  if (response.status !== undefined) slim.status = response.status;
  // Filter extra for the same reason: extra callers like report_progress pass
  // `{ updated_at: persisted.updated_at }` which can be undefined when the
  // route body omits the field.
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) slim[key] = value;
  };
  // Prefer next_step_hint (emitted by real routes via hint()); fall back to
  // __hint for test-harness / legacy shapes.
  if (response.next_step_hint) slim.next_step_hint = response.next_step_hint;
  else if (response.__hint) slim.next_step_hint = response.__hint;
  // Preserve operational passthrough fields (contract R2).
  if (response._subagent_event_id) slim._subagent_event_id = response._subagent_event_id;
  if (response.local_state) slim.local_state = response.local_state;
  if (response.warning) slim.warning = response.warning;
  return slim;
}
