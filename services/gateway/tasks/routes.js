/**
 * HTTP route mounting for the tasks plane. Takes an adapter object
 * shaped `{ add(method, path, handler) }` — typically the gateway's
 * Bun Server wrapper. Each handler delegates to state-machine.js
 * after extracting the parsed body / url params / actor identity.
 *
 * Kept thin by design: the adapter shape is intentionally minimal so
 * Phase 7+ can supply whatever router style it likes (regex, trie,
 * express-style) without re-writing this file.
 */

import {
  createTask,
  listTasks,
  getTask,
  getNextTask,
  claimTask,
  resumeTask,
  reportProgress,
  submitTask,
  requestVerification,
  approveTask,
  rejectTask,
  updateTask,
  cancelTask,
  failTask,
  releaseTask,
  reassignTask,
  commentTask,
  reopenTask,
  getAudit,
  requestTaskDelete,
  approveTaskDelete,
  denyTaskDelete,
  approveAllTaskDeletes,
  denyAllTaskDeletes,
  listDeleteRequests,
} from './state-machine.js';
import { appendJournalEntry, readJournal } from './journal.js';
import { claimOrphan } from './orphan.js';
import { scanAll, reconcileProjectById } from './reconciler.js';
import { swallow } from '@cortex/sdk/errors';

/**
 * @param {{ add: (method: string, path: string, handler: Function) => void }} adapter
 */
export function mountTaskRoutes(adapter) {
  if (!adapter || typeof adapter.add !== 'function') {
    throw new Error('mountTaskRoutes: adapter must expose add(method, path, handler)');
  }

  // Collection routes --------------------------------------------------
  adapter.add('POST', '/v1/api/tasks', (ctx) =>
    createTask({ body: ctx.body, actor: ctx.actor, isAdmin: ctx.isAdmin }));

  adapter.add('GET', '/v1/api/tasks', (ctx) =>
    listTasks({ query: ctx.query || {}, actor: ctx.actor, isAdmin: ctx.isAdmin }));

  adapter.add('GET', '/v1/api/tasks/next', (ctx) =>
    getNextTask({ actor: ctx.actor, platform: ctx.platform || ctx.query?.platform }));

  // Delete-request workflow (request → admin approve/deny + bulk-all).
  // Wired to the transitions.js handlers, which carry the authz (request:
  // owner/creator/admin; approve/deny: admin-only), audit_log + ledger
  // dual-write, folder-rename, and wake emit — exactly like every other
  // task route. The literal `delete-requests` GET is registered BEFORE
  // GET /v1/api/tasks/:id so the :id wildcard never shadows it.
  adapter.add('GET', '/v1/api/tasks/delete-requests', () => listDeleteRequests());

  adapter.add('POST', '/v1/api/tasks/delete-requests/approve-all', (ctx) =>
    approveAllTaskDeletes({ actor: ctx.actor, isAdmin: ctx.isAdmin }));

  adapter.add('POST', '/v1/api/tasks/delete-requests/deny-all', (ctx) =>
    denyAllTaskDeletes({ actor: ctx.actor, isAdmin: ctx.isAdmin }));

  adapter.add('POST', '/v1/api/tasks/:id/request-delete', (ctx) =>
    requestTaskDelete({
      taskId: ctx.params.id, body: ctx.body,
      actor: ctx.actor, isAdmin: ctx.isAdmin,
    }));

  adapter.add('POST', '/v1/api/tasks/:id/approve-delete', (ctx) =>
    approveTaskDelete({ taskId: ctx.params.id, actor: ctx.actor, isAdmin: ctx.isAdmin }));

  adapter.add('POST', '/v1/api/tasks/:id/deny-delete', (ctx) =>
    denyTaskDelete({ taskId: ctx.params.id, actor: ctx.actor, isAdmin: ctx.isAdmin }));

  // D2 — MANUAL RECONCILE TRIGGER (Phase 4).
  // Admin-socket-ONLY: POST /v1/api/tasks/reconcile -> scanAll({ dryRun }).
  // Enabled only when CORTEX_FOLDER_AUTHORITY=1 (kill-switch: absent/0 →
  // 404 so callers know the endpoint is inactive, not forbidden).
  // TCP requests are rejected by the isAdminSocket guard — same mechanism
  // as auth/routes.js (admin_scope_requires_unix_socket).
  adapter.add('POST', '/v1/api/tasks/reconcile', async (ctx) => {
    if (process.env.CORTEX_FOLDER_AUTHORITY !== '1') {
      return { status: 404, body: { error: 'not_found', reason: 'CORTEX_FOLDER_AUTHORITY not enabled' } };
    }
    if (!ctx.isAdminSocket) {
      return { status: 403, body: { error: 'admin_scope_requires_unix_socket', reason: 'use ~/.cortex/admin.sock' } };
    }
    // Strict boolean coercion: ONLY boolean false disables the safe dry-run
    // default. Any other value (absent, null, 0, "", "false", "no") is treated
    // as dry_run=true to prevent accidental live writes from malformed input.
    const dryRun = ctx.body?.dry_run === false ? false : true;
    try {
      return { status: 200, body: await scanAll({ dryRun }) };
    } catch (err) {
      swallow('tasks.reconcile_failed', err);
      return { status: 500, body: { error: 'reconcile_failed', message: err.message } };
    }
  });

  // D2 — PER-PROJECT MANUAL RECONCILE TRIGGER (Phase 4).
  // Admin-socket-ONLY: POST /v1/api/tasks/reconcile/:project_id.
  // Same Phase-4 gate as the collection route: CORTEX_FOLDER_AUTHORITY=1
  // required (404 if absent), ctx.isAdminSocket required (403 otherwise),
  // strict dry_run coercion defaulting to true — only boolean false is live.
  adapter.add('POST', '/v1/api/tasks/reconcile/:project_id', async (ctx) => {
    if (process.env.CORTEX_FOLDER_AUTHORITY !== '1') {
      return { status: 404, body: { error: 'not_found', reason: 'CORTEX_FOLDER_AUTHORITY not enabled' } };
    }
    if (!ctx.isAdminSocket) {
      return { status: 403, body: { error: 'admin_scope_requires_unix_socket', reason: 'use ~/.cortex/admin.sock' } };
    }
    // Strict boolean coercion: ONLY boolean false disables the safe dry-run
    // default. Any other value (absent, null, 0, "", "false", "no") is treated
    // as dry_run=true to prevent accidental live writes from malformed input.
    const dryRun = ctx.body?.dry_run === false ? false : true;
    try {
      const result = await reconcileProjectById(ctx.params.project_id, { dryRun });
      if (result?.error === 'project_not_found') return { status: 404, body: { error: 'not_found' } };
      return { status: 200, body: { dry_run: dryRun, scanned_at: new Date().toISOString(), ...result } };
    } catch (err) {
      swallow('tasks.reconcile_project_failed', err);
      return { status: 500, body: { error: 'reconcile_failed', message: err.message } };
    }
  });

  // Per-task routes ----------------------------------------------------
  adapter.add('GET', '/v1/api/tasks/:id', (ctx) =>
    getTask({ taskId: ctx.params.id }));

  adapter.add('PATCH', '/v1/api/tasks/:id', (ctx) =>
    updateTask({
      taskId: ctx.params.id, body: ctx.body,
      actor: ctx.actor, isAdmin: ctx.isAdmin,
    }));

  adapter.add('POST', '/v1/api/tasks/:id/claim', (ctx) =>
    claimTask({ taskId: ctx.params.id, actor: ctx.actor }));

  adapter.add('POST', '/v1/api/tasks/:id/resume', (ctx) =>
    resumeTask({ taskId: ctx.params.id, actor: ctx.actor, isAdmin: ctx.isAdmin }));

  adapter.add('POST', '/v1/api/tasks/:id/progress', (ctx) =>
    reportProgress({ taskId: ctx.params.id, body: ctx.body, actor: ctx.actor }));

  adapter.add('POST', '/v1/api/tasks/:id/submit', (ctx) =>
    submitTask({ taskId: ctx.params.id, body: ctx.body, actor: ctx.actor }));

  adapter.add('POST', '/v1/api/tasks/:id/request-review', (ctx) =>
    requestVerification({
      taskId: ctx.params.id,
      body: ctx.body,
      actor: ctx.actor,
      isAdmin: ctx.isAdmin,
    }));

  adapter.add('POST', '/v1/api/tasks/:id/approve', (ctx) =>
    approveTask({
      taskId: ctx.params.id, body: ctx.body,
      actor: ctx.actor, isAdmin: ctx.isAdmin,
    }));

  adapter.add('POST', '/v1/api/tasks/:id/reject', (ctx) =>
    rejectTask({
      taskId: ctx.params.id, body: ctx.body,
      actor: ctx.actor, isAdmin: ctx.isAdmin,
    }));

  adapter.add('POST', '/v1/api/tasks/:id/cancel', (ctx) =>
    cancelTask({
      taskId: ctx.params.id, body: ctx.body,
      actor: ctx.actor, isAdmin: ctx.isAdmin,
    }));

  adapter.add('POST', '/v1/api/tasks/:id/fail', (ctx) =>
    failTask({
      taskId: ctx.params.id, body: ctx.body,
      actor: ctx.actor, isAdmin: ctx.isAdmin,
    }));

  adapter.add('POST', '/v1/api/tasks/:id/release', (ctx) =>
    releaseTask({
      taskId: ctx.params.id, body: ctx.body,
      actor: ctx.actor, isAdmin: ctx.isAdmin,
    }));

  adapter.add('POST', '/v1/api/tasks/:id/reassign', (ctx) =>
    reassignTask({
      taskId: ctx.params.id, body: ctx.body,
      actor: ctx.actor, isAdmin: ctx.isAdmin,
    }));

  adapter.add('POST', '/v1/api/tasks/:id/comments', (ctx) =>
    commentTask({ taskId: ctx.params.id, body: ctx.body, actor: ctx.actor }));

  adapter.add('POST', '/v1/api/tasks/:id/reopen', (ctx) =>
    reopenTask({
      taskId: ctx.params.id, body: ctx.body,
      actor: ctx.actor, isAdmin: ctx.isAdmin,
    }));

  adapter.add('GET', '/v1/api/tasks/:id/audit', (ctx) =>
    getAudit({ taskId: ctx.params.id }));

  // Journal subresource ------------------------------------------------
  adapter.add('POST', '/v1/api/tasks/:id/journal', (ctx) =>
    appendJournalEntry({ taskId: ctx.params.id, body: ctx.body, actor: ctx.actor }));

  adapter.add('GET', '/v1/api/tasks/:id/journal', (ctx) =>
    readJournal({ taskId: ctx.params.id, query: ctx.query || {} }));

  // Orphan adoption ----------------------------------------------------
  adapter.add('POST', '/v1/api/tasks/:id/claim-orphan', (ctx) =>
    claimOrphan({ taskId: ctx.params.id, body: ctx.body, actor: ctx.actor }));
}
