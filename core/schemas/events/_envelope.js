/**
 * Event envelope — the shape every event carries on the wire and on disk.
 * Payload is validated separately by subject via payloadSchemaFor() in
 * this directory's index.js.
 *
 * Invariants:
 *   - `id` is a v4 UUID generated at emit() time
 *   - `subject` is lowercase dotted, e.g. "task.claimed"
 *   - `ts` is epoch milliseconds (not seconds, not ISO)
 *   - `v` is the envelope format version; bumped only when the envelope
 *     shape itself changes, NOT when a payload schema changes
 */
import { z } from 'zod';

export const EventEnvelopeSchema = z.object({
  id: z.string().uuid(),
  subject: z.string().regex(/^[a-z]+\.[a-z_]+$/),
  ts: z.number().int().nonnegative(),
  source: z.string().min(1),
  // Legacy-prefixed task ids (bridge, proxy/cost) flow through the
  // envelope `task_id` meta field. Mirror the payload relaxation in
  // bridge.js + cost.js so strict .uuid() here doesn't reject events the
  // per-plane payloads already accept. The `events.task_id` DB column is
  // TEXT so downstream reads are untyped regardless.
  task_id: z.string().min(1).optional(),
  session_id: z.string().optional(),
  trace_id: z.string().optional(),
  payload: z.unknown(),
  v: z.literal(1),
});
