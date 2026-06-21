/**
 * Task visibility + claim predicates. Pure — no DB, no filesystem, no
 * emit. Extracted so every authorization decision is unit-testable in
 * isolation.
 *
 * Both helpers take an `equals(a, b)` function so this module doesn't
 * have to depend on the auth plane. In practice callers inject either
 * a strict `===` comparator (tests) or a `sameBaseAgent` resolver that
 * collapses `nova-2`/`nova-3` to their shared base `nova` (prod).
 *
 * `equals` defaults to strict equality so callers with no base
 * resolution still get correct behaviour; visibility is conservative
 * either way (deny by default).
 */

import { parseTaskMetadata } from './_meta.js';

function defaultEquals(a, b) {
  if (!a || !b) return false;
  return a === b;
}

/**
 * A task is visible to an agent if the agent is the assignee, the
 * reviewer (persisted in metadata.reviewer_agent), or the creator. When
 * called without an agentIdentity (e.g. from an admin channel) the
 * predicate short-circuits to `true` — admin lists include every row.
 *
 * @param {object} task — row from the `tasks` table
 * @param {string | null | undefined} agentIdentity
 * @param {(a: string|null|undefined, b: string|null|undefined) => boolean} [equals]
 */
export function taskVisibleToAgent(task, agentIdentity, equals = defaultEquals) {
  if (!agentIdentity) return true;
  if (!task) return false;
  const reviewerAgent = extractReviewerAgent(task);
  return (
    equals(task.assigned_to, agentIdentity) ||
    equals(reviewerAgent, agentIdentity) ||
    equals(task.created_by, agentIdentity)
  );
}

/**
 * An agent can claim a pending task if:
 *   1. Its status is still `pending`,
 *   2. If the row has a targeted `assigned_to` hint, the claimer shares
 *      the same base identity (prevents one agent poaching another's
 *      pre-assigned work),
 *   3. There's no incompatible platform pin (the legacy schema stored
 *      platform pins in metadata; this predicate honours that).
 *
 * @param {object} task
 * @param {string | null | undefined} agentIdentity
 * @param {string | null | undefined} platform
 * @param {(a: string|null|undefined, b: string|null|undefined) => boolean} [equals]
 */
export function canClaimPendingTask(task, agentIdentity, platform, equals = defaultEquals) {
  if (!task) return false;
  if (task.status !== 'pending') return false;
  if (task.assigned_to && !equals(task.assigned_to, agentIdentity || platform)) {
    return false;
  }
  const pinnedPlatform = extractAssignedPlatform(task);
  if (pinnedPlatform) {
    if (!platform) return false;
    if (String(pinnedPlatform).toLowerCase() !== String(platform).toLowerCase()) {
      return false;
    }
  }
  return true;
}

// -- private helpers --------------------------------------------------------

/**
 * The reviewer identity lives in tasks.metadata.reviewer_agent (set by
 * submitTask→verifyTask via json_set). Corrupt JSON falls back to null so
 * the predicate stays conservative (no visibility).
 */
function extractReviewerAgent(task) {
  const md = parseMetadata(task?.metadata);
  return md?.reviewer_agent || null;
}

function extractAssignedPlatform(task) {
  const md = parseMetadata(task?.metadata);
  return md?.assigned_platform || null;
}

// parseMetadata → parseTaskMetadata from ./_meta.js (S3 consolidation).
// The _meta.js home uses the { _error } sentinel on corrupt rows; callers
// that only read safe fields (reviewer_agent, assigned_platform) tolerate
// { _error } naturally because those keys are absent in the sentinel object.
const parseMetadata = parseTaskMetadata;
