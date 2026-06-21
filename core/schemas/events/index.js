/**
 * Event schema barrel — the single entry point for validating event
 * payloads. Callers resolve subject→schema via `payloadSchemaFor()`
 * instead of importing the namespace maps directly so there is one
 * place that knows every subject the system emits.
 */
import { EventEnvelopeSchema } from './_envelope.js';
import { TaskEventPayloadMap } from './task.js';
import { SessionEventPayloadMap } from './session.js';
import { AgentEventPayloadMap } from './agent.js';
import { BridgeEventPayloadMap } from './bridge.js';
import { ReviewEventPayloadMap } from './review.js';
import { SubmissionEventPayloadMap } from './submission.js';
import { GateEventPayloadMap } from './gate.js';
import { RouterEventPayloadMap } from './router.js';
import { CostEventPayloadMap } from './cost.js';
import { RunEventPayloadMap } from './run.js';
import { ProviderEventPayloadMap } from './provider.js';
import { VerificationEventPayloadMap } from './verification.js';
import { SystemEventPayloadMap } from './system.js';
import { AuthEventPayloadMap } from './auth.js';

export const EventPayloadMap = Object.freeze({
  ...TaskEventPayloadMap,
  ...SessionEventPayloadMap,
  ...AgentEventPayloadMap,
  ...BridgeEventPayloadMap,
  ...ReviewEventPayloadMap,
  ...SubmissionEventPayloadMap,
  ...GateEventPayloadMap,
  ...RouterEventPayloadMap,
  ...CostEventPayloadMap,
  ...RunEventPayloadMap,
  ...ProviderEventPayloadMap,
  ...VerificationEventPayloadMap,
  ...SystemEventPayloadMap,
  ...AuthEventPayloadMap,
});

/**
 * @param {string} subject  e.g. "task.claimed"
 * @returns {import('zod').ZodTypeAny | null}  schema for the payload, or null
 *   if the subject is not in the known taxonomy
 */
export function payloadSchemaFor(subject) {
  return EventPayloadMap[subject] ?? null;
}

export { EventEnvelopeSchema };
export { FindingSchema } from './submission.js';
