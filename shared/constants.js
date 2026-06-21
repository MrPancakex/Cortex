import { TaskStatusSchema } from '../core/schemas/task.js';

export const PORTS = {
  BACKEND: 4830,
  GATEWAY: 4840,
  WEBSOCKET: 4841
};

export const SYSTEM = {
  VERSION: "0.1.0"
};

/**
 * Task lifecycle status codes. Kept as a keyed object for legacy call sites;
 * prefer `TASK_STATUSES` when you need to enumerate the allowed values or
 * round-trip against the zod enum created in Phase 3.
 */
export const STATUS = {
  PENDING: 'pending',
  CLAIMED: 'claimed',
  IN_PROGRESS: 'in_progress',
  SUBMITTED: 'submitted',
  REVIEW: 'review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

/**
 * Canonical, ordered list of task lifecycle statuses — DERIVED from
 * `core/schemas/task.js TaskStatusSchema` (the single source of truth per
 * cortex-module-ssot-layout.md §3). It CANNOT drift: it IS the schema's
 * `.options`. The TypeScript mirror is `shared/constants.d.ts`, pinned by the
 * `TASK_STATUSES === TaskStatusSchema.options` contract test (S6).
 * Includes 'orphaned' (the Phase-5 session-reaper status) automatically.
 */
export const TASK_STATUSES = Object.freeze([...TaskStatusSchema.options]);

/**
 * Agent runtime statuses surfaced to the dashboard. Must stay aligned with
 * `shared/schemas/agent.js::AgentStatusSchema`.
 */
export const AGENT_STATUSES = Object.freeze(['ACTIVE', 'IDLE', 'OFFLINE']);
