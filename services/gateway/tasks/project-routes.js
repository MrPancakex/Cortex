/**
 * Project CRUD routes. Thin dispatchers over the tasks-plane prepared
 * statements — lifted from legacy routes/projects.js but adapted to the
 * rebuild's `projects` table schema (001_initial_schema.sql).
 *
 * Project identity: we accept either a UUID (DB id) or a human slug
 * derived from the name. The DB uses UUIDs; slug lookup is a convenience
 * for CLI callers (`cortex project get widget-rebuild`).
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { swallow } from '@cortex/sdk/errors';
import { getTaskStatements } from './statements.js';
import { getDb } from '@cortex/sdk/db';
import path from 'node:path';
import { slugify, resolveProjectsRoot } from './paths.js';
import { ok, created, badRequest, notFound, forbidden } from './_internals.js';
import { parseTaskMetadata } from './_meta.js';

// --- schemas --------------------------------------------------------------

const ProjectCreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  root_path: z.string().min(1).max(500).optional(),
  default_reviewer: z.string().max(100).optional(),
});

const ProjectUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  default_reviewer: z.string().max(100).nullable().optional(),
  root_path: z.string().min(1).max(500).optional(),
});

// --- helpers --------------------------------------------------------------

// ok/created/badRequest/notFound/forbidden → from ./_internals.js (S5: envelope SSOT).
// parseMetadata → parseTaskMetadata from ./_meta.js (S3 consolidation).
const parseMetadata = parseTaskMetadata;

function resolveProject(idOrSlug) {
  const stmts = getTaskStatements();
  const direct = stmts.getProject.get(idOrSlug);
  if (direct) return direct;
  // Slug fallback: scan the list for a matching slug(name).
  const list = stmts.listProjects.all();
  return list.find((p) => slugify(p.name) === idOrSlug) || null;
}

function serializeProject(row) {
  if (!row) return null;
  const meta = parseMetadata(row.metadata);
  return {
    id: row.id,
    name: row.name,
    slug: slugify(row.name),
    description: row.description || '',
    root_path: row.root_path,
    default_reviewer: meta.default_reviewer || null,
    phase_count: meta.phase_count || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    metadata: meta,
  };
}

// --- handlers -------------------------------------------------------------

export function createProject({ body, isAdmin = false }) {
  const parsed = ProjectCreateSchema.safeParse(body);
  if (!parsed.success) return badRequest('invalid_body', { issues: parsed.error.issues });
  // A caller-supplied root_path is the same authoritative-task-folder primitive
  // updateProject admin-gates — mirror it here. The default resolution (no
  // root_path) stays open to any caller; only a custom path needs admin.
  if (parsed.data.root_path !== undefined) {
    if (!isAdmin) return forbidden('admin_only');
    if (!path.isAbsolute(parsed.data.root_path)) return badRequest('root_path_must_be_absolute');
  }
  const stmts = getTaskStatements();
  const id = randomUUID();
  const rootPath = parsed.data.root_path
    || path.join(resolveProjectsRoot(), slugify(parsed.data.name));
  const metadata = JSON.stringify({
    default_reviewer: parsed.data.default_reviewer || null,
  });
  try {
    stmts.createProject.run(
      id,
      parsed.data.name,
      parsed.data.description || '',
      rootPath,
      metadata,
    );
  } catch (err) {
    swallow('tasks.project_create_failed', err);
    return { status: 500, body: { error: 'project_create_failed', message: err.message } };
  }
  const row = stmts.getProject.get(id);
  return created(serializeProject(row));
}

export function listProjectsHandler() {
  const stmts = getTaskStatements();
  const rows = stmts.listProjects.all();
  return ok({ projects: rows.map(serializeProject), total: rows.length });
}

export function getProjectHandler({ projectId }) {
  const project = resolveProject(projectId);
  if (!project) return notFound();
  return ok(serializeProject(project));
}

export function updateProject({ projectId, body, isAdmin = false }) {
  const parsed = ProjectUpdateSchema.safeParse(body || {});
  if (!parsed.success) return badRequest('invalid_body', { issues: parsed.error.issues });
  // root_path feeds getProjectDir() → the reconciler ingests task.json from it
  // authoritatively, so an attacker-set root_path can forge "approved" tasks
  // that bypass the review loop. Admin-only, and must be an absolute path.
  if (parsed.data.root_path !== undefined) {
    if (!isAdmin) return forbidden('admin_only');
    if (!path.isAbsolute(parsed.data.root_path)) return badRequest('root_path_must_be_absolute');
  }
  const project = resolveProject(projectId);
  if (!project) return notFound();
  const meta = parseMetadata(project.metadata);
  if (parsed.data.default_reviewer !== undefined) {
    meta.default_reviewer = parsed.data.default_reviewer;
  }
  const stmts = getTaskStatements();
  try {
    stmts.updateProjectMetadata.run(JSON.stringify(meta), project.id);
    if (parsed.data.root_path !== undefined) {
      stmts.updateProjectRootPath.run(parsed.data.root_path, project.id);
    }
    if (parsed.data.name !== undefined || parsed.data.description !== undefined) {
      const newName = parsed.data.name ?? project.name;
      const newDesc = parsed.data.description ?? (project.description || '');
      stmts.updateProjectNameDesc.run(newName, newDesc, project.id);
    }
  } catch (err) {
    swallow('tasks.project_update_failed', err);
    return { status: 500, body: { error: 'project_update_failed' } };
  }
  const updated = stmts.getProject.get(project.id);
  return ok(serializeProject(updated));
}

export function listProjectTasks({ projectId }) {
  const project = resolveProject(projectId);
  if (!project) return notFound();
  const stmts = getTaskStatements();
  const rows = stmts.listTasksByProject.all(project.id);
  return ok({
    project_id: project.id,
    tasks: rows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      priority: row.priority,
      assigned_to: row.assigned_to,
      phase_id: row.phase_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })),
    total: rows.length,
  });
}


// --- project delete-request handlers (B2a) --------------------------------

export function requestProjectDelete({ projectId, body, actor, isAdmin = false }) {
  // Requesting deletion only flags the project (non-destructive), but it must
  // still be an authenticated caller — never attribute an anonymous request to
  // 'admin'. An admin (operator) may request without a distinct actor id.
  if (!isAdmin && !actor?.id) return forbidden('auth_required');
  const project = resolveProject(projectId);
  if (!project) return notFound();
  const stmts = getTaskStatements();
  const requestedAt = new Date().toISOString();
  const requestedBy = actor?.id || 'admin';
  try {
    const info = stmts.requestProjectDelete.run(requestedAt, requestedBy, project.id);
    if (Number(info.changes) === 0) return { status: 409, body: { error: 'delete_already_requested' } };
  } catch (err) {
    swallow('tasks.project_delete_req_failed', err);
    return { status: 500, body: { error: 'project_delete_request_failed', message: err.message } };
  }
  return ok({ project_id: project.id, delete_requested: true });
}

export function listProjectDeleteRequestsHandler() {
  const stmts = getTaskStatements();
  const rows = stmts.listProjectDeleteRequests.all();
  return ok({ projects: rows.map(serializeProject), total: rows.length });
}

export function approveProjectDelete({ projectId, actor, isAdmin = false }) {
  // Destructive + admin-only: hard-deletes the project AND all its task rows.
  //
  // SCOPE (intentional, per review #5): this is a DB-ONLY delete. Unlike the
  // per-task approveTaskDelete, it deliberately does NOT write per-task
  // audit_log/ledger.jsonl entries, emit task.deleted events, or rename task
  // folders. Project deletion is a coarse operator action; the on-disk project
  // folder is left in place for manual cleanup. Rich audit/ledger/archive
  // semantics for project-delete are a flagged follow-up (they need project-level
  // event subjects + the dual-write path, which live in transitions.js). Until
  // then, callers must treat project-delete as a DB-row purge, not an audited
  // lifecycle transition. Covered by the tasks-projects.test.js delete authz test.
  if (!isAdmin) return forbidden('admin_only');
  void actor;
  const project = resolveProject(projectId);
  if (!project) return notFound();
  const meta = parseMetadata(project.metadata);
  if (!meta.delete_requested_at) return { status: 409, body: { error: 'no_pending_delete_request' } };
  const stmts = getTaskStatements();
  try {
    // Atomic cascade: if the project DELETE matches 0 rows (e.g. a concurrent
    // denyProjectDelete cleared the flag between the check above and here),
    // throw so the task DELETE rolls back instead of orphaning the tasks.
    getDb().transaction(() => {
      stmts.hardDeleteTasksByProject.run(project.id);
      const info = stmts.hardDeleteProject.run(project.id);
      if (Number(info.changes) === 0) throw new Error('no_pending_delete_request');
    })();
  } catch (err) {
    if (err.message === 'no_pending_delete_request') {
      return { status: 409, body: { error: 'no_pending_delete_request' } };
    }
    swallow('tasks.project_approve_delete_failed', err);
    return { status: 500, body: { error: 'project_approve_delete_failed', message: err.message } };
  }
  return ok({ project_id: project.id, deleted: true });
}

export function denyProjectDelete({ projectId, isAdmin = false }) {
  // Clearing a delete request is an admin action, mirroring denyTaskDelete.
  if (!isAdmin) return forbidden('admin_only');
  const project = resolveProject(projectId);
  if (!project) return notFound();
  const stmts = getTaskStatements();
  try {
    const info = stmts.denyProjectDelete.run(project.id);
    if (Number(info.changes) === 0) return { status: 409, body: { error: 'no_pending_delete_request' } };
  } catch (err) {
    swallow('tasks.project_deny_delete_failed', err);
    return { status: 500, body: { error: 'project_deny_delete_failed', message: err.message } };
  }
  return ok({ project_id: project.id, delete_denied: true });
}

/**
 * HTTP mounting. Hooks up the five CRUD endpoints. Kept symmetrical with
 * `mountTaskRoutes` so Phase 8's server.js can wire both with one line
 * each.
 */
export function mountProjectRoutes(adapter) {
  if (!adapter || typeof adapter.add !== 'function') {
    throw new Error('mountProjectRoutes: adapter must expose add(method, path, handler)');
  }
  adapter.add('POST', '/v1/api/projects', (ctx) => createProject({ body: ctx.body, isAdmin: ctx.isAdmin }));
  adapter.add('GET', '/v1/api/projects', () => listProjectsHandler());
  adapter.add('GET', '/v1/api/projects/delete-requests', () => listProjectDeleteRequestsHandler());
  adapter.add('GET', '/v1/api/projects/:id', (ctx) =>
    getProjectHandler({ projectId: ctx.params.id }));
  adapter.add('PATCH', '/v1/api/projects/:id', (ctx) =>
    updateProject({ projectId: ctx.params.id, body: ctx.body, isAdmin: ctx.isAdmin }));
  adapter.add('GET', '/v1/api/projects/:id/tasks', (ctx) =>
    listProjectTasks({ projectId: ctx.params.id }));
  adapter.add('POST', '/v1/api/projects/:id/request-delete', (ctx) =>
    requestProjectDelete({
      projectId: ctx.params.id, body: ctx.body,
      actor: ctx.actor, isAdmin: ctx.isAdmin,
    }));
  adapter.add('POST', '/v1/api/projects/:id/approve-delete', (ctx) =>
    approveProjectDelete({ projectId: ctx.params.id, actor: ctx.actor, isAdmin: ctx.isAdmin }));
  adapter.add('POST', '/v1/api/projects/:id/deny-delete', (ctx) =>
    denyProjectDelete({ projectId: ctx.params.id, isAdmin: ctx.isAdmin }));
}
