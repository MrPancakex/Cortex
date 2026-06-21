/**
 * system.* event payload schemas. Infrastructure-level lifecycle events:
 *   boot, reaper sweeps, and reconciliation runs.
 *
 * `started_at` timestamps use ISO datetime (z.string().datetime()) per spec.
 * This diverges from the epoch-ms integer convention used in task.js and
 * session.js — flagged for future normalisation.
 */
import { z } from 'zod';

const IsoDateSchema = z.string().datetime();

export const SystemBootSchema = z.object({
  version: z.string().min(1),
  started_at: IsoDateSchema,
  components_loaded: z.array(z.string()),
}).strict();

export const SystemReaperSweptSchema = z.object({
  reaper_name: z.string().min(1),
  marked: z.number().int().nonnegative(),
  candidates: z.number().int().nonnegative(),
  elapsed_ms: z.number().int().nonnegative(),
}).strict();

export const SystemReconcileStartedSchema = z.object({
  // `project_id` is optional — reconcile may run system-wide (no project
  // scope) or scoped to a single project.
  project_id: z.string().min(1).optional(),
  dry_run: z.boolean(),
  started_at: IsoDateSchema,
}).strict();

export const SystemReconcileCompletedSchema = z.object({
  project_id: z.string().min(1).optional(),
  dry_run: z.boolean(),
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  parity_failures: z.number().int().nonnegative(),
  elapsed_ms: z.number().int().nonnegative(),
}).strict();

/**
 * F-04: Emitted when the RBAC scope matrix fails to load (file missing,
 * parse error, etc.). Operators can subscribe to surface outages without
 * attaching a debugger.
 */
export const SystemMatrixLoadFailedSchema = z.object({
  path: z.string(),
  code: z.string().optional(),
  message: z.string().optional(),
  timestamp: z.number().int(),
}).strict();

export const SystemEventPayloadMap = {
  'system.boot': SystemBootSchema,
  'system.reaper_swept': SystemReaperSweptSchema,
  'system.reconcile_started': SystemReconcileStartedSchema,
  'system.reconcile_completed': SystemReconcileCompletedSchema,
  'system.matrix_load_failed': SystemMatrixLoadFailedSchema,
};
