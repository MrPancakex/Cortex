/**
 * Task journal — Phase 5's structured, type-enforced append-only progress
 * log. Replaces pattern-matching on progress_reports.stage as the
 * authoritative completeness signal for submit_result and
 * request_verification.
 *
 * Three entry points:
 *   appendJournalEntry         — insert a row (handler boundary)
 *   readJournal                — ordered read (handler boundary)
 *   checkJournalCompleteness   — pure DB read used by submitTask +
 *                                requestVerification to decide 409 vs 200
 *
 * The journal enum is closed (see task_journal.entry_type CHECK in
 * migrations/003_tasks_journal.sql). submit_result demands
 * REQUIRED_ENTRY_TYPES (planning/context/test); request_verification in
 * strict mode additionally requires 'decision' + 'test' before handing
 * off to a reviewer. See core/schemas/task.js for the closed enum + the
 * REQUIRED_ENTRY_TYPES export.
 */

import { randomUUID } from 'node:crypto';
import {
  JournalAppendSchema,
  JournalQuerySchema,
  REQUIRED_ENTRY_TYPES,
} from '@cortex/core/schemas';
import { swallow } from '@cortex/sdk/errors';
import { getTaskStatements } from './statements.js';

const EXTRA_STRICT_TYPES = Object.freeze(['decision', 'test']);

function badRequest(error, extras = {}) {
  return { status: 400, body: { error, ...extras } };
}
function notFound() {
  return { status: 404, body: { error: 'not_found' } };
}

/**
 * POST /v1/api/tasks/:id/journal
 * Appends a journal entry. `task_id` comes from the URL; callers never
 * pass it in the body (the schema rejects unknown keys on strict zod
 * parses, but we strip before parse anyway).
 *
 * @param {{ taskId: string, body: unknown, actor: { id: string } }} args
 */
export function appendJournalEntry({ taskId, body, actor }) {
  if (!actor || !actor.id) {
    return { status: 401, body: { error: 'missing or invalid token' } };
  }
  const parsed = JournalAppendSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest('invalid_body', { issues: parsed.error.issues });
  }
  const stmts = getTaskStatements();
  const task = stmts.getTask.get(taskId);
  if (!task) return notFound();

  const id = randomUUID();
  const filesChanged = JSON.stringify(parsed.data.files_changed || []);
  const metadata = JSON.stringify(parsed.data.metadata || {});
  try {
    stmts.insertTaskJournal.run(
      id, taskId, parsed.data.entry_type, parsed.data.summary,
      filesChanged, metadata, actor.id,
    );
  } catch (err) {
    // DB-layer failure (FK, CHECK violation, disk full). Surface the
    // message to the caller; swallow() records the metric so operators
    // can see the spike without the gateway crashing.
    swallow('tasks.journal_append_failed', err);
    return { status: 500, body: { error: 'journal_append_failed', message: err.message } };
  }
  const row = stmts.journalByTaskAsc.all(taskId).find((r) => r.id === id) || null;
  return {
    status: 201,
    body: {
      id,
      task_id: taskId,
      entry_type: parsed.data.entry_type,
      summary: parsed.data.summary,
      author: actor.id,
      created_at: row?.created_at ?? null,
    },
  };
}

/**
 * GET /v1/api/tasks/:id/journal[?entry_type=planning&limit=50]
 */
export function readJournal({ taskId, query = {} }) {
  const parsed = JournalQuerySchema.safeParse(query);
  if (!parsed.success) {
    return badRequest('invalid_query', { issues: parsed.error.issues });
  }
  const stmts = getTaskStatements();
  const task = stmts.getTask.get(taskId);
  if (!task) return notFound();

  const limit = parsed.data.limit ?? 200;
  let rows;
  if (parsed.data.entry_type) {
    rows = stmts.journalByTaskFilteredAsc.all(taskId, parsed.data.entry_type, limit);
  } else {
    rows = stmts.journalByTaskAsc.all(taskId).slice(0, limit);
  }
  const entries = rows.map(hydrate);
  return {
    status: 200,
    body: { task_id: taskId, entries, total: entries.length },
  };
}

/**
 * Pure check — does this task have a non-empty journal entry for each of
 * the required types? Called by submitTask (REQUIRED_ENTRY_TYPES only) and
 * requestVerification ({ strict: true } adds decision + test).
 *
 * An entry counts as "present" only when its summary trims to non-empty.
 * A whitespace-only summary is effectively a gamed entry and doesn't
 * satisfy the gate.
 *
 * @param {string} taskId
 * @param {{ strict?: boolean }} [options]
 * @returns {{ complete: boolean, missing: string[], present: string[], total_entries: number }}
 */
export function checkJournalCompleteness(taskId, options = {}) {
  const stmts = getTaskStatements();
  const rows = stmts.journalByTaskAsc.all(taskId);
  const present = new Set();
  for (const row of rows) {
    if (!row.summary) continue;
    if (String(row.summary).trim().length === 0) continue;
    present.add(row.entry_type);
  }
  const required = options.strict
    ? [...new Set([...REQUIRED_ENTRY_TYPES, ...EXTRA_STRICT_TYPES])]
    : [...REQUIRED_ENTRY_TYPES];
  const missing = required.filter((t) => !present.has(t));
  return {
    complete: missing.length === 0,
    missing,
    present: [...present],
    total_entries: rows.length,
  };
}

// -- helpers ---------------------------------------------------------------

function hydrate(row) {
  return {
    id: row.id,
    task_id: row.task_id,
    entry_type: row.entry_type,
    summary: row.summary,
    files_changed: safeJson(row.files_changed, []),
    metadata: safeJson(row.metadata, {}),
    author: row.author,
    created_at: row.created_at,
  };
}

function safeJson(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try {
    const v = JSON.parse(raw);
    return v ?? fallback;
  } catch (err) {
    // A row we wrote should always parse; if it doesn't, treat it as
    // corruption and fall back to the caller's default rather than
    // propagating. Reference err so Rule 2.B is satisfied.
    void err;
    return fallback;
  }
}
