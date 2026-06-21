/**
 * Priority ordering. Extracted from
 * `services/gateway/routes/cortex-tasks.js:119-127` (`priorityRank` switch)
 * so the constant surface matches what Phase 4-8 imports as `PRIORITY_RANK`
 * from `@cortex/core/constants`.
 *
 * NOT-QUITE-VERBATIM NOTE: the legacy switch enumerates four cases
 * (critical/high/medium/low → 4/3/2/1) and falls through to `default: 0`.
 * The rebuild assigns `normal: 2` as well so the rank table covers every
 * value in `TaskPrioritySchema` without a runtime default surprise — the DB
 * CHECK and the task schema both allow `normal`, and treating `normal`
 * identically to `medium` matches what callers ended up doing in practice.
 * Unknown priority still → 0 via the `?? 0` fallback in `priorityRank()`.
 */
export const PRIORITIES = Object.freeze(['low', 'medium', 'normal', 'high', 'critical']);

export const PRIORITY_RANK = Object.freeze({
  critical: 4,
  high: 3,
  medium: 2,
  normal: 2,
  low: 1,
});

export function priorityRank(priority) {
  return PRIORITY_RANK[priority] ?? 0;
}
