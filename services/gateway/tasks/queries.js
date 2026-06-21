/**
 * Task state-machine — read paths (Phase 3.0.b extraction).
 *
 * The non-mutating half of the former state-machine.js: list, get,
 * get-next, audit. No status transitions, no event emission. Pure
 * extraction — logic byte-identical to the original. state-machine.js
 * re-exports these unchanged so every existing import still resolves.
 */
import { resolveBaseAgent } from '@cortex/sdk/auth';
import {
  ok,
  hint,
  requireTask,
  pickHint,
  priorityRank,
  sameAgent,
} from './_internals.js';
import { getTaskStatements } from './statements.js';
import {
  serializeTaskDetail,
  serializeTaskSummary,
} from './serialize.js';
import { taskVisibleToAgent, canClaimPendingTask } from './access.js';
import { parseTaskMetadata } from './_meta.js';

// -- list ------------------------------------------------------------------

export function listTasks({ query = {}, actor, isAdmin = false } = {}) {
  const stmts = getTaskStatements();
  // Cap raised from 200 to 5000 to support dashboard snapshot returning the
  // full task inventory in one shot. v1 had a similar uncapped behavior; the
  // 200-cap was a v0.2 carryover that broke the dashboard for any operator
  // with more than 200 tasks.
  const limit = Math.min(Math.max(1, Number(query.limit) || 50), 5000);
  const status = query.status || null;
  const agent = query.agent || null;
  const agentFilter = agent ? (resolveBaseAgent(agent) || agent) : null;
  const projectId = query.project_id || null;
  const source = query.source || null;
  const fetchLimit = Math.max(limit, 1000);

  let rows;
  if (status || agent || projectId || source) {
    rows = stmts.listTasksFiltered.all(status, agentFilter, projectId, source, fetchLimit);
  } else {
    rows = stmts.listTasks.all(fetchLimit);
  }

  const scoped = (actor && !isAdmin)
    ? rows.filter((r) => taskVisibleToAgent(r, actor.id, sameAgent))
    : rows;
  const sliced = scoped.slice(0, limit);
  return ok({
    tasks: sliced.map(serializeTaskSummary),
    total: scoped.length,
    ...hint(status === 'review'
      ? 'Pick up tasks in review where you are the reviewer.'
      : 'Use task_get for full detail, claim_task to start.'),
  });
}

// -- getTask ---------------------------------------------------------------

export function getTask({ taskId }) {
  const r = requireTask(taskId);
  if (r.status) return { status: r.status, body: r.body };
  const detail = serializeTaskDetail(r.task);
  return ok({
    ...detail,
    ...hint(pickHint(r.task.status)),
  });
}

// -- getNextTask -----------------------------------------------------------

export function getNextTask({ actor, platform } = {}) {
  const stmts = getTaskStatements();
  // First preference: a review row assigned to this reviewer.
  if (actor?.id) {
    const review = stmts.listTasksByStatus.all('review', 200).find((t) => {
      const md = parseTaskMetadata(t.metadata);
      return !md._error && sameAgent(md.reviewer_agent, actor.id);
    });
    if (review) {
      return ok({
        id: review.id,
        title: review.title,
        description: review.description,
        status: review.status,
        reviewer_agent: actor.id,
        created_at: review.created_at,
        ...hint('Review task assigned to you — claim_task to adopt the review.'),
      });
    }
  }
  // Next: an unclaimed pending row this agent can claim.
  const pending = stmts.listTasksByStatus.all('pending', 200)
    .filter((t) => canClaimPendingTask(t, actor?.id, platform, sameAgent))
    .sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority)
      || (a.created_at || '').localeCompare(b.created_at || ''))[0] || null;
  if (!pending) {
    return ok({
      id: null,
      message: 'No pending tasks available.',
      ...hint('No work available — call task_create or poll again.'),
    });
  }
  return ok({
    id: pending.id,
    title: pending.title,
    description: pending.description,
    status: pending.status,
    priority: pending.priority,
    created_at: pending.created_at,
    ...hint('Claim it if it matches your work, or task_create if nothing fits.'),
  });
}

// -- getAudit --------------------------------------------------------------

/**
 * Returns the structured audit trail for a task from the `audit_log` table
 * populated by the dual-write contract in transitions.js (Slice A Phase 6).
 *
 * The audit_log is the single canonical, truly-chronological ledger: every
 * lifecycle transition writes one row, and listAuditForTask returns them
 * ORDER BY created_at ASC, rowid ASC — the implicit rowid breaks same-second
 * ties in true insertion order (created_at is only second-granularity).
 *
 * We deliberately return ONLY audit_log rows here and do NOT merge in
 * progress / comments / journal. Those live in separate tables, each with its
 * own independent second-granularity created_at clock, so a merged view cannot
 * be made truly chronological for same-second cross-source events without a
 * shared sub-second/sequence key on the dual-write path — which lives in the
 * review-loop-fenced transitions.js. Per the review guidance ("use a
 * shared monotonic key across all sources, or stop presenting it as one
 * chronological stream"), getAudit is the audit_log lifecycle trail; the
 * progress / comment / journal detail is exposed by getTask, each ordered
 * within its own type.
 *
 * The `payload` TEXT column is parsed to JSON; `from_status` / `to_status` are
 * promoted to the top level when present so callers don't have to drill in.
 */
export function getAudit({ taskId }) {
  const r = requireTask(taskId);
  if (r.status) return { status: r.status, body: r.body };
  const stmts = getTaskStatements();
  const events = stmts.listAuditForTask.all(taskId).map((row) => {
    let payload;
    try { payload = JSON.parse(row.payload || '{}'); } catch (_) { payload = {}; }
    const { from_status, to_status, ...rest } = payload;
    return {
      kind: 'audit',
      id: row.id,
      task_id: row.task_id,
      project_id: row.project_id,
      actor: row.actor,
      event_type: row.event_type,
      ...(from_status !== undefined ? { from_status } : {}),
      ...(to_status !== undefined ? { to_status } : {}),
      payload: rest,
      created_at: row.created_at,
    };
  });
  return ok({
    task_id: taskId,
    events,
    total: events.length,
    ...hint('Audit trail (audit_log lifecycle events, chronological by created_at then insertion order).'),
  });
}

// -- listDeleteRequests ----------------------------------------------------
// V2 dashboard-backend restoration. Read path for the delete-request
// approval queue the frontend renders. Pending = metadata carries
// $.delete_requested_at (set by requestTaskDelete, cleared by deny).

export function listDeleteRequests() {
  const stmts = getTaskStatements();
  const rows = stmts.listDeleteRequests.all();
  // Key is `requests` to match the established dashboard consumer
  // (useApi.ts reads delData.requests). The backend is new; align it
  // to the existing frontend contract rather than change the consumer.
  return ok({
    requests: rows.map(serializeTaskSummary),
    total: rows.length,
    ...hint('Admin: approve-delete or deny-delete each, or bulk approve-all/deny-all.'),
  });
}
