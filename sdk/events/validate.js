/**
 * Event payload validation dispatcher. Resolves subject → schema via
 * `payloadSchemaFor()` then runs a zod safeParse. Returns a discriminated
 * result so callers can decide whether to emit, recover, or reject.
 *
 * Unknown subjects (no schema registered) are treated as errors — the
 * taxonomy is closed by design so a typo'd subject doesn't silently land
 * in the events table.
 */

import { payloadSchemaFor, EventEnvelopeSchema } from '../../core/schemas/events/index.js';

/**
 * @param {string} subject
 * @param {unknown} payload
 * @returns {{ ok: true, payload: unknown } | { ok: false, reason: string, issues?: unknown }}
 */
export function validatePayload(subject, payload) {
  const schema = payloadSchemaFor(subject);
  if (schema == null) {
    return { ok: false, reason: 'unknown_subject' };
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, reason: 'payload_invalid', issues: parsed.error.issues };
  }
  return { ok: true, payload: parsed.data };
}

/**
 * @param {unknown} envelope  candidate event object (id/subject/ts/source/...)
 * @returns {{ ok: true, envelope: unknown } | { ok: false, reason: string, issues?: unknown }}
 */
export function validateEnvelope(envelope) {
  const parsed = EventEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    return { ok: false, reason: 'envelope_invalid', issues: parsed.error.issues };
  }
  return { ok: true, envelope: parsed.data };
}
