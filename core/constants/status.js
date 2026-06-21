/**
 * Canonical enum sets. Zod schemas reuse these so a new status value only
 * needs to be added in one place.
 *
 * `TASK_STATUSES` is derived from `TaskStatusSchema.options` so there is a
 * single source of truth. Session / agent status lists mirror the gateway's
 * existing DB shapes until those land as first-class schemas (Phase 5/6).
 */
import { TaskStatusSchema } from '../schemas/task.js';
import { AgentStatusSchema } from '../schemas/agent.js';

/**
 * Task statuses — Phase 1 carries the 9 values present in the legacy
 * shared/schemas/task.js. 'orphaned' lands in Phase 5.
 */
export const TASK_STATUSES = Object.freeze([...TaskStatusSchema.options]);

/**
 * Session lifecycle — matches the legacy gateway vocabulary until Phase 6
 * lands a SessionStatusSchema in core/schemas/session.js.
 */
export const SESSION_STATUSES = Object.freeze([
  'active',
  'idle',
  'draining',
  'closed',
  'poisoned',
]);

/**
 * Agent statuses — UPPERCASE enum preserved from legacy
 * shared/schemas/agent.js so the dashboard's existing consumers don't
 * break. Extra states like 'busy'/'stale' that downstream normalisers map
 * into this triple.
 */
export const AGENT_STATUSES = Object.freeze([...AgentStatusSchema.options]);

/**
 * Terminal vs active task statuses. 'submitted' and 'review' are active —
 * the task is still in flight even though the agent is not mutating it.
 */
export const TERMINAL_TASK_STATUSES = Object.freeze(['approved', 'cancelled', 'failed']);
export const ACTIVE_TASK_STATUSES = Object.freeze([
  'pending',
  'claimed',
  'in_progress',
  'submitted',
  'review',
  'rejected',
]);

export function isTerminalTaskStatus(status) {
  return TERMINAL_TASK_STATUSES.includes(status);
}

export function isActiveTaskStatus(status) {
  return ACTIVE_TASK_STATUSES.includes(status);
}
