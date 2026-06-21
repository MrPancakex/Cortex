/**
 * subagent-lifecycle.js — direct-DB activity/cost ledger for subagents.
 *
 * Records into the `subagent_events` table (migration 010). Two write
 * paths:
 *
 *   1. Auto / task-worker — `registerTaskWorker` is called by claim_task
 *      after a successful claim, and `completeTaskWorker` by submit_result
 *      after a successful submit. The pair is what makes the dashboard's
 *      "what is each agent working on right now" view work.
 *
 *   2. Manual — `subagent_register` / `subagent_complete` MCP tools call
 *      `registerSubagent` / `completeSubagent` with agent-reported
 *      tokens + cost. Used by general-purpose workers, codex-watcher
 *      runs, and any other non-task subagent the parent wants tracked.
 *
 * **Why direct DB writes, not HTTP:** The legacy `lib/subagent-lifecycle.js`
 * round-tripped through `/api/subagents/*` HTTP routes the rebuild has
 * never mounted (and §12.6 Plane 1 is the only thing that would mount
 * them). Writing to the DB directly keeps the lifecycle hook honest in
 * the rebuild without dragging in routes the spawn/control plane is the
 * proper home for.
 *
 * The lifecycle module DOES NOT spawn or supervise subagent processes —
 * that's process management, owned by the §12.6 supervisor when it
 * lands. This module is purely the ledger.
 */

import crypto from 'node:crypto';

/**
 * Terminal statuses a subagent_events row can transition INTO via
 * completeSubagent / failTaskWorker. Anything outside this set is a
 * lifecycle integrity violation (an in-progress / paused / random
 * string would corrupt the dashboard's state filtering and the orphan
 * reaper's WHERE clause).
 *
 * Re-exported from the sessions barrel so tool boundaries (zod enum)
 * and the SDK helper agree on a single source of truth.
 */
export const SUBAGENT_TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled']);

function assertTerminalStatus(status) {
  if (!SUBAGENT_TERMINAL_STATUSES.includes(status)) {
    throw new Error(
      `subagent-lifecycle: status must be one of ${SUBAGENT_TERMINAL_STATUSES.join(', ')}; got "${status}"`,
    );
  }
}

/**
 * Build a fresh `subagent_events` row identifier. Exported so callers
 * can pre-allocate an id (e.g. to surface it on the response before
 * the INSERT lands and stash it on the agent side).
 */
export function generateSubagentEventId() {
  return crypto.randomUUID();
}

/**
 * Auto-register a task-worker subagent on `claim_task`. Returns the
 * event_id so the caller can surface it in the response body — agents
 * that want to attribute cost to a specific event later can pass it
 * back via subagent_complete.
 *
 * Fields default to the task-worker shape (subagent_type='task-worker',
 * runtime='generic') because no AI model is spawned at claim time —
 * the parent agent IS the worker; we're just stamping a receipt for
 * "agent started working on task X at time T."
 */
export function registerTaskWorker({ db, parentAgent, taskId, taskTitle }) {
  if (!db) throw new Error('registerTaskWorker: db is required');
  if (!parentAgent) throw new Error('registerTaskWorker: parentAgent is required');
  if (!taskId) throw new Error('registerTaskWorker: taskId is required');

  const eventId = generateSubagentEventId();
  const subagentId = `${parentAgent}:task-${taskId}-${Date.now()}`;
  const startedAt = Math.floor(Date.now() / 1000);

  db.prepare(
    `INSERT INTO subagent_events
       (id, parent_agent, subagent_id, subagent_type, description, task_id,
        status, started_at, runtime)
     VALUES (?, ?, ?, 'task-worker', ?, ?, 'running', ?, 'generic')`,
  ).run(eventId, parentAgent, subagentId, taskTitle ?? null, taskId, startedAt);

  return eventId;
}

/**
 * Auto-complete a task-worker subagent on `submit_result`. The summary
 * is the agent's submit-result summary; tokens/cost default to 0 in
 * the lifecycle path (the legacy table left them at 0 too — agents
 * report cost via the proxy/usage plane on a different timeline).
 *
 * `parentAgent` is required: the UPDATE is scoped by it so one agent can
 * never close another agent's event-row even if it obtains the event_id.
 *
 * Returns true if a row was updated, false if the event_id+parent
 * pair doesn't resolve to a 'running' row (idempotent on duplicate
 * completes; covers the cross-agent denial path).
 */
export function completeTaskWorker({ db, eventId, parentAgent, summary }) {
  if (!db) throw new Error('completeTaskWorker: db is required');
  if (!eventId) throw new Error('completeTaskWorker: eventId is required');
  if (!parentAgent) throw new Error('completeTaskWorker: parentAgent is required');

  const completedAt = Math.floor(Date.now() / 1000);
  const result = db.prepare(
    `UPDATE subagent_events
       SET status = 'completed',
           completed_at = ?,
           duration_ms = (? - started_at) * 1000,
           result_summary = COALESCE(?, result_summary)
       WHERE id = ? AND parent_agent = ? AND status = 'running'`,
  ).run(completedAt, completedAt, summary ?? null, eventId, parentAgent);

  return result.changes === 1;
}

/**
 * Mark a running subagent as failed. Used by the orphan reaper or by
 * agents that want to record a non-success outcome. Same owner-scope
 * discipline as `completeTaskWorker`.
 */
export function failTaskWorker({ db, eventId, parentAgent, reason }) {
  if (!db) throw new Error('failTaskWorker: db is required');
  if (!eventId) throw new Error('failTaskWorker: eventId is required');
  if (!parentAgent) throw new Error('failTaskWorker: parentAgent is required');

  const completedAt = Math.floor(Date.now() / 1000);
  const result = db.prepare(
    `UPDATE subagent_events
       SET status = 'failed',
           completed_at = ?,
           duration_ms = (? - started_at) * 1000,
           result_summary = COALESCE(?, result_summary)
       WHERE id = ? AND parent_agent = ? AND status = 'running'`,
  ).run(completedAt, completedAt, reason ?? null, eventId, parentAgent);

  return result.changes === 1;
}

/**
 * Find the most-recent 'running' task-worker row for (taskId, parentAgent).
 * Used by submit_result when the caller didn't preserve the event_id
 * from the claim_task response. Returns the event_id or null.
 */
export function lookupRunningTaskWorker({ db, taskId, parentAgent }) {
  if (!db) throw new Error('lookupRunningTaskWorker: db is required');

  const row = db.prepare(
    `SELECT id FROM subagent_events
       WHERE task_id = ? AND parent_agent = ? AND status = 'running'
       ORDER BY started_at DESC
       LIMIT 1`,
  ).get(taskId, parentAgent);

  return row ? row.id : null;
}

/**
 * Manual register — used by `subagent_register` MCP tool. Caller passes
 * description + subagent_type explicitly; defaults to runtime='claude'
 * since manual registers are typically for AI-driven children.
 *
 * Returns the event_id and the synthesized subagent_id (so the caller
 * can echo both back to the parent agent for later cost attribution
 * via subagent_complete).
 */
export function registerSubagent({
  db,
  parentAgent,
  subagentType,
  description,
  taskId = null,
  model = null,
  provider = null,
  runtime = 'claude',
}) {
  if (!db) throw new Error('registerSubagent: db is required');
  if (!parentAgent) throw new Error('registerSubagent: parentAgent is required');
  if (!description) throw new Error('registerSubagent: description is required');

  const eventId = generateSubagentEventId();
  const subagentId = `${parentAgent}:${subagentType || 'general-purpose'}-${Date.now()}`;
  const startedAt = Math.floor(Date.now() / 1000);

  db.prepare(
    `INSERT INTO subagent_events
       (id, parent_agent, subagent_id, subagent_type, description, task_id,
        status, started_at, model, provider, runtime)
     VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
  ).run(
    eventId, parentAgent, subagentId, subagentType || 'general-purpose',
    description, taskId, startedAt, model, provider, runtime,
  );

  return { eventId, subagentId };
}

/**
 * Manual complete — used by `subagent_complete` MCP tool. Caller passes
 * the event_id (returned from `registerSubagent`) plus the cost
 * accounting fields the parent agent collected during the run.
 *
 * `parentAgent` is required and pinned in the WHERE clause so a
 * stolen event_id can't be used to close another agent's event.
 *
 * Empty / undefined fields are preserved (COALESCE) so a partial
 * report does not zero out an earlier-recorded value.
 */
export function completeSubagent({
  db,
  eventId,
  parentAgent,
  status = 'completed',
  durationMs,
  toolCalls,
  resultSummary,
  inputTokens,
  cachedInputTokens,
  outputTokens,
  costUsd,
}) {
  if (!db) throw new Error('completeSubagent: db is required');
  if (!eventId) throw new Error('completeSubagent: eventId is required');
  if (!parentAgent) throw new Error('completeSubagent: parentAgent is required');
  // Defense in depth — the MCP boundary's zod enum should already have
  // rejected an arbitrary string, but a non-MCP caller from inside the
  // SDK (e.g. the orphan reaper, or an internal admin tool) could pass
  // anything. Throwing here keeps the table's status column constrained
  // to terminal lifecycle outcomes regardless of how completeSubagent
  // is reached.
  assertTerminalStatus(status);

  const completedAt = Math.floor(Date.now() / 1000);
  const result = db.prepare(
    `UPDATE subagent_events
       SET status = ?,
           completed_at = ?,
           duration_ms = COALESCE(?, (? - started_at) * 1000),
           tool_calls = COALESCE(?, tool_calls),
           result_summary = COALESCE(?, result_summary),
           input_tokens = COALESCE(?, input_tokens),
           cached_input_tokens = COALESCE(?, cached_input_tokens),
           output_tokens = COALESCE(?, output_tokens),
           cost_usd = COALESCE(?, cost_usd)
       WHERE id = ? AND parent_agent = ? AND status = 'running'`,
  ).run(
    status,
    completedAt,
    durationMs ?? null, completedAt,
    toolCalls ?? null,
    resultSummary ?? null,
    inputTokens ?? null,
    cachedInputTokens ?? null,
    outputTokens ?? null,
    costUsd ?? null,
    eventId,
    parentAgent,
  );

  return result.changes === 1;
}

/**
 * Pure read — list subagent_events for a parent. Used by the
 * `subagent_list` MCP tool and by the dashboard.
 */
export function listSubagents({ db, parentAgent, limit = 50 }) {
  if (!db) throw new Error('listSubagents: db is required');

  return db.prepare(
    `SELECT id, parent_agent, subagent_id, subagent_type, description, task_id,
            status, started_at, completed_at, duration_ms, tool_calls,
            result_summary, input_tokens, cached_input_tokens, output_tokens,
            cost_usd, model, provider, runtime
       FROM subagent_events
       WHERE parent_agent = ?
       ORDER BY started_at DESC
       LIMIT ?`,
  ).all(parentAgent, limit);
}
