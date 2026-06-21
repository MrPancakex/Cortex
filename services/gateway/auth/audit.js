/**
 * Auth-grant audit helpers. Appends events to the project ledger.jsonl
 * AND emits on the in-process event bus.
 *
 * Path resolution precedence (F-06):
 *   1. CORTEX_PROJECTS_DIR
 *   2. CORTEX_AUDIT_LEDGER_DIR
 *   3. $CORTEX_HOME/projects  (CORTEX_HOME defaults per core/constants/paths.js)
 *
 * If still unresolvable, logs a HIGH-severity warning to stderr and
 * increments swallowCount — never silently no-ops.
 *
 * Audit project slug is configurable via CORTEX_AUDIT_PROJECT_SLUG (F-25).
 * Default: "cortex".
 */

import path from 'node:path';
import { resolveProjectsRoot } from '@cortex/core/constants';
import { swallow } from '@cortex/sdk/errors';
import { emit } from '@cortex/sdk/events';
import { appendLedger } from '../tasks/ledger.js';

/** Count of swallowed audit-write failures so operators can detect silent loss. */
export let swallowCount = 0;

/** Reset for tests only. */
export function resetSwallowCountForTests() {
  swallowCount = 0;
}

/** Resolve the audit project dir. */
function resolveAuditDir() {
  const projectsDir =
    process.env.CORTEX_PROJECTS_DIR ||
    process.env.CORTEX_AUDIT_LEDGER_DIR ||
    resolveProjectsRoot();

  const slug = process.env.CORTEX_AUDIT_PROJECT_SLUG || 'cortex';
  return path.join(projectsDir, slug);
}

/**
 * Build a bus-compatible payload (matching auth event schemas) from the raw
 * audit payload. The raw payload may carry extra fields (ttl_seconds,
 * justification, etc.) that zod strips — we just ensure required timestamp
 * fields are present.
 */
function toBusPayload(subject, payload) {
  const now = Date.now();
  if (subject === 'auth.scope_granted') {
    return {
      grant_id: payload.grant_id,
      agent: payload.agent,
      target_scope: payload.target_scope,
      granted_by: payload.granted_by || 'unknown',
      granted_at: payload.granted_at ?? now,
    };
  }
  if (subject === 'auth.scope_revoked') {
    return {
      grant_id: payload.grant_id,
      agent: payload.agent,
      reason: payload.reason,
      revoked_at: payload.revoked_at ?? now,
    };
  }
  if (subject === 'auth.scope_expired') {
    return {
      grant_id: payload.grant_id,
      agent: payload.agent,
      expired_at: payload.expired_at ?? now,
    };
  }
  return payload;
}

/**
 * @param {'auth.scope_granted'|'auth.scope_revoked'|'auth.scope_expired'} subject
 * @param {object} payload
 */
export function auditGrant(subject, payload) {
  const dir = resolveAuditDir();
  const ts = new Date().toISOString();

  // Ledger append
  try {
    appendLedger(dir, { ts, subject, payload });
  } catch (err) {
    swallowCount += 1;
    process.stderr.write(
      `[WARN][HIGH] auth.grant_audit_failed: ledger append to ${dir} failed — ` +
      `${err?.message || err} (swallowCount=${swallowCount})\n`,
    );
    swallow('auth.grant_audit_failed', err);
  }

  // Event bus emit — wrapped so a schema mismatch never breaks the API contract
  try {
    emit(subject, toBusPayload(subject, payload));
  } catch (err) {
    swallow('auth.grant_bus_emit_failed', err);
  }
}
