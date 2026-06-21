/**
 * Content-level submission gate. Hooks the task-submission path: when
 * an agent calls `submit_result`, the payload's free-text fields and any
 * attached file bodies are scanned against the shared stub detector in
 * sdk/analysis/detect-stub.js.
 *
 * A `severity: 'fatal'` finding rejects the submission with
 * `reason_code=stub_detected`; non-fatal findings are surfaced to the
 * caller for display without blocking.
 *
 * This file is a thin shell around the shared detector; the gate's job
 * is the glue — pulling strings out of the submission payload and
 * routing the verdict into the middleware contract used by the gateway
 * adapter.
 */

import { swallow } from '@cortex/sdk/errors';
import { detectStub, hasFatalStub } from '../../../sdk/analysis/detect-stub.js';
import { emitSubmissionFlaggedStub } from '../tasks/index.js';
import { MAX_BRIDGE_BODY_BYTES } from '@cortex/core/constants';

// Per-field scan cap. Strings longer than this are skipped so a single
// huge artefact body cannot freeze the submission path while the regex
// engine walks it. Reuses MAX_BRIDGE_BODY_BYTES as a reasonable upper
// bound (128 KiB) — same "larger than a realistic submission" ceiling.
const DEFAULT_MAX_BYTES = MAX_BRIDGE_BODY_BYTES;

// Default fields on a submission payload to scan. Callers can override.
const DEFAULT_FIELDS = Object.freeze(['summary', 'notes', 'description']);

/**
 * Inspect a submission payload for stub/fake patterns. Returns a
 * `{ blocked, findings }` pair:
 *   - blocked  — true when any finding is fatal severity.
 *   - findings — the full flat list (fatal + warn) for display.
 *
 * Side effect: emits submission.flagged_stub when `blocked === true`
 * AND a task id is present. Callers that want to skip the emit (e.g.
 * dry-run scanners) pass `{ emit: false }`.
 *
 * @param {{
 *   taskId?: string,
 *   submitter?: string,
 *   payload: object,
 *   fields?: string[],
 *   maxBytes?: number,
 *   emit?: boolean,
 * }} args
 */
export function inspectSubmission({
  taskId,
  submitter,
  payload,
  fields = DEFAULT_FIELDS,
  maxBytes = DEFAULT_MAX_BYTES,
  emit: shouldEmit = true,
} = {}) {
  if (!payload || typeof payload !== 'object') {
    return { blocked: false, findings: [] };
  }
  const findings = [];
  try {
    for (const field of fields) {
      const value = payload[field];
      if (typeof value === 'string' && value.length > 0 && value.length <= maxBytes) {
        findings.push(...detectStub(value, { path: `body.${field}` }));
      }
    }
    if (Array.isArray(payload.artefacts)) {
      for (let i = 0; i < payload.artefacts.length; i++) {
        const a = payload.artefacts[i];
        if (a && typeof a.body === 'string' && a.body.length <= maxBytes) {
          findings.push(...detectStub(a.body, {
            path: `body.artefacts[${i}]:${a.path || 'unknown'}`,
          }));
        }
      }
    }
    if (Array.isArray(payload.files_changed)) {
      for (let i = 0; i < payload.files_changed.length; i++) {
        const f = payload.files_changed[i];
        if (f && typeof f.content === 'string' && f.content.length <= maxBytes) {
          findings.push(...detectStub(f.content, {
            path: `body.files_changed[${i}]:${f.path || 'unknown'}`,
          }));
        }
      }
    }
  } catch (err) {
    swallow('gate.stub_inspect_failed', err);
  }

  const blocked = hasFatalStub(findings);
  if (blocked && shouldEmit && taskId) {
    try {
      emitSubmissionFlaggedStub({
        taskId,
        submitter: submitter || 'unknown',
        findings: findings
          .filter((f) => f && f.severity === 'fatal')
          .map((f) => ({
            path: f.path || null,
            line: f.line || null,
            pattern: f.rule || null,
            excerpt: f.excerpt || null,
          })),
      });
    } catch (err) {
      swallow('gate.stub_emit_failed', err);
    }
  }
  return { blocked, findings };
}

/**
 * Middleware form for the gateway's adapter pattern. Returns a handler
 * shaped `(ctx) => { status, body } | null` where `null` means
 * "pass-through, no block". Callers chain this before the submission
 * handler.
 *
 * Kept as a factory so callers can bind task id / submitter resolution
 * to whatever their adapter exposes.
 */
export function stubDetectorMiddleware(options = {}) {
  return (ctx) => {
    const taskId = options.taskIdFrom ? options.taskIdFrom(ctx) : ctx?.params?.taskId || ctx?.body?.task_id;
    const submitter = options.submitterFrom ? options.submitterFrom(ctx) : (ctx?.actor?.id || ctx?.actor);
    const result = inspectSubmission({
      taskId,
      submitter,
      payload: ctx?.body || {},
      fields: options.fields,
      maxBytes: options.maxBytes,
      emit: options.emit !== false,
    });
    if (result.blocked) {
      return {
        status: 422,
        body: {
          error: 'stub_detected',
          reason_code: 'stub_detected',
          findings: result.findings,
        },
      };
    }
    // Attach findings to ctx so downstream handlers can surface warnings
    // on the successful path without re-scanning.
    ctx.gate = { ...(ctx.gate || {}), submissionFindings: result.findings };
    return null;
  };
}
