/**
 * Phase CRUD routes. Thin wrappers around phase prepared statements.
 * A phase is a grouping of tasks inside a project — ordinal-ordered so
 * the UI can render "Phase 1 of N".
 *
 * Phase names can repeat across projects; uniqueness is per-project.
 * Ordinal is assigned monotonically at creation; callers don't pass it.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { swallow } from '@cortex/sdk/errors';
import { getDb } from '@cortex/sdk/db';
import { getTaskStatements } from './statements.js';
import { ok, created, badRequest, notFound } from './_internals.js';

// Phase creation: project_id comes from the URL (POST /v1/api/projects/:id/phases),
// not the body. `name` is optional — callers (MCP phase_add, platform-backend
// gateway-proxy) post empty bodies and let the server auto-derive
// "Phase ${ordinal+1}".
const PhaseCreateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
});

// ok/created/badRequest/notFound → from ./_internals.js (S5: envelope SSOT).

function serializePhase(row) {
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    ordinal: row.ordinal,
    status: row.status,
    created_at: row.created_at,
  };
}

export function listPhasesForProject({ projectId }) {
  const stmts = getTaskStatements();
  const project = stmts.getProject.get(projectId);
  if (!project) return notFound();
  const rows = stmts.listPhases.all(projectId);
  return ok({
    project_id: projectId,
    phases: rows.map(serializePhase),
    total: rows.length,
  });
}

export function addPhase({ projectId, body }) {
  if (!projectId) return badRequest('missing_project_id');
  const parsed = PhaseCreateSchema.safeParse(body ?? {});
  if (!parsed.success) return badRequest('invalid_body', { issues: parsed.error.issues });
  const stmts = getTaskStatements();
  const project = stmts.getProject.get(projectId);
  if (!project) return notFound();
  const ordinal = stmts.countPhases.get(projectId)?.count || 0;
  const name = parsed.data.name || `Phase ${ordinal + 1}`;
  const id = randomUUID();
  try {
    stmts.createPhase.run(id, projectId, name, ordinal);
  } catch (err) {
    swallow('tasks.phase_create_failed', err);
    return { status: 500, body: { error: 'phase_create_failed', message: err.message } };
  }
  const row = stmts.listPhases.all(projectId).find((p) => p.id === id);
  return created(serializePhase(row));
}

// V2-gap B7: delete a phase by its 1-based phase_number (URL param maps
// to the 0-based ordinal stored in DB). Child tasks survive — the FK is
// ON DELETE SET NULL, so tasks.phase_id becomes NULL rather than the
// tasks being deleted. After delete, remaining phases' ordinals are
// compacted to stay contiguous (addPhase derives next ordinal from a
// row count; gaps would break monotonic assignment).
export function deletePhase({ projectId, phaseNumber }) {
  if (!projectId) return badRequest('missing_project_id');
  const parsed = z.coerce.number().int().positive().safeParse(phaseNumber);
  if (!parsed.success) return badRequest('invalid_phase_number');
  const ordinal = parsed.data - 1;
  const stmts = getTaskStatements();
  const project = stmts.getProject.get(projectId);
  if (!project) return notFound();
  const phases = stmts.listPhases.all(projectId);
  const target = phases.find((p) => (p.ordinal ?? 0) === ordinal);
  if (!target) return notFound();
  try {
    const db = getDb();
    db.transaction(() => {
      stmts.deletePhaseByOrdinal.run(projectId, ordinal);
      stmts.compactPhaseOrdinals.run(projectId, ordinal);
    })();
  } catch (err) {
    swallow('tasks.phase_delete_failed', err);
    return { status: 500, body: { error: 'phase_delete_failed', message: err.message } };
  }
  return ok({ deleted: serializePhase(target) });
}

export function mountPhaseRoutes(adapter) {
  if (!adapter || typeof adapter.add !== 'function') {
    throw new Error('mountPhaseRoutes: adapter must expose add(method, path, handler)');
  }
  adapter.add('GET', '/v1/api/projects/:id/phases', (ctx) =>
    listPhasesForProject({ projectId: ctx.params.id }));
  adapter.add('POST', '/v1/api/projects/:id/phases', (ctx) =>
    addPhase({ projectId: ctx.params.id, body: ctx.body }));
  adapter.add('DELETE', '/v1/api/projects/:id/phases/:phase_number', (ctx) =>
    deletePhase({ projectId: ctx.params.id, phaseNumber: ctx.params.phase_number }));
}
