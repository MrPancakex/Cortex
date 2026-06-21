/**
 * Canonical Zod primitive schemas — the single source of truth for cross-cutting
 * identifier types used throughout core/schemas/events/*.js and core/schemas/agent.js.
 *
 * ONE DEFINITION CONTRACT: every event schema that carries an agent_id or task_id
 * field MUST import from here. Re-declaring these locally (e.g. `z.string().min(1)`)
 * breaks the constraint: a string that is syntactically invalid as an agent id
 * (wrong casing, special chars, too long) would silently pass validation.
 *
 * The `_primitives` contract test (`core/tests/primitives-contract.test.js`) is
 * the mechanical guard: it proves that an agent_id invalid under the real regex
 * is REJECTED by every event schema that was previously accepting it via min(1).
 */
import { z } from 'zod';

/**
 * Agent identifier — lowercase slug with optional numeric suffix.
 * Examples: `nova`, `nova-2`, `orion`, `my_bot-99`.
 *
 * This is the REAL regex from core/schemas/agent.js. It is stricter than the
 * bare `z.string().min(1)` that was previously copy-pasted into 11 event files.
 * A bearer string, a UUID, or an uppercase name all fail here; they should fail.
 */
export const AgentIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}(-\d+)?$/);

/**
 * Task identifier — UUID v4 string as emitted by the gateway's task-creation path.
 *
 * Use this for all event schemas where the task_id is a gateway-generated UUID
 * (task.*, run.*, review.*, submission.*, verification.*).
 *
 * Do NOT use this for cost.* events — the cost plane must accept legacy-prefixed
 * task ids (e.g. `task_legacy-xyz`) from the proxy handler. Use LegacyTaskIdSchema
 * there instead.
 */
export const TaskIdSchema = z.string().uuid();

/**
 * Legacy task identifier — non-empty string, NOT constrained to UUID format.
 *
 * Used exclusively by cost.* event schemas because upstream callers (proxy/handler.js,
 * streaming.js) may emit cost events with task ids that carry a prefix and therefore
 * do not pass strict UUID validation. Requiring `.uuid()` here previously caused
 * `emit()` to reject the payload; the swallow at the emit site hid the drop, so
 * the event bus drifted from the DB forever.
 *
 * Relaxing to min(1) is intentional and documented — it matches the same decision
 * already made for bridge.sent.task_id (see core/schemas/events/bridge.js).
 */
export const LegacyTaskIdSchema = z.string().min(1);
