/**
 * DB-row → JSON response serializers. Every HTTP handler in state-machine
 * routes its output through one of these so the shape a dashboard or bot
 * receives is consistent with the rest of the plane.
 *
 * Three layers:
 *   serializeTaskSummary — minimal row for list endpoints
 *   serializeTaskDetail  — full row + nested progress + comments + journal
 *   serializeProgress    — single progress_reports row
 *   serializeComment     — single task_comments row
 *   serializeJournalEntry — single task_journal row
 *
 * Metadata is JSON-decoded on the way out so clients never have to
 * re-parse. Corrupt metadata surfaces as `{ _error: 'metadata_corrupt' }`
 * rather than throwing — a malformed row stays renderable.
 */

import { getTaskStatements } from './statements.js';
import { parseTaskMetadata } from './_meta.js';
import { safeJsonParse } from '@cortex/sdk/http';

// parseMetadata → parseTaskMetadata from ./_meta.js (S3 consolidation).
// Sentinel contract { _error: 'metadata_corrupt' } is preserved by the home.
const parseMetadata = parseTaskMetadata;

function parseTags(raw) {
  if (Array.isArray(raw)) return raw.slice(0, 32).map(String);
  if (!raw) return [];
  const p = safeJsonParse(raw);
  return Array.isArray(p.value) ? p.value.map(String) : [];
}

export function serializeProgress(row) {
  if (!row) return null;
  const meta = parseMetadata(row.metadata);
  return {
    id: row.id,
    timestamp: row.created_at,
    stage: row.stage,
    percent: row.percent ?? 0,
    message: row.message || '',
    files_changed: Array.isArray(meta?.files_changed) ? meta.files_changed : [],
    stub_detected: !!meta?.stub_detected,
  };
}

export function serializeComment(row) {
  if (!row) return null;
  return {
    id: row.id,
    author: row.author,
    body: row.body,
    created_at: row.created_at,
  };
}

export function serializeJournalEntry(row) {
  if (!row) return null;
  const filesParsed = safeJsonParse(row.files_changed || '[]');
  const files = Array.isArray(filesParsed.value) ? filesParsed.value : [];
  return {
    id: row.id,
    task_id: row.task_id,
    entry_type: row.entry_type,
    summary: row.summary,
    files_changed: files,
    metadata: parseMetadata(row.metadata),
    author: row.author,
    created_at: row.created_at,
  };
}

export function serializeTaskSummary(row) {
  if (!row) return null;
  const meta = parseMetadata(row.metadata);
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    assigned_to: row.assigned_to,
    reviewer_agent: meta?.reviewer_agent ?? null,
    priority: row.priority || 'medium',
    section: meta?.section ?? null,
    project_id: row.project_id,
    phase_id: row.phase_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Full detail — includes every progress row, every comment, every
 * journal entry. Intentionally denormalised: the dashboard calls
 * GET /v1/api/tasks/:id ONCE and renders the entire timeline without
 * N additional round-trips.
 */
export function serializeTaskDetail(row) {
  if (!row) return null;
  const stmts = getTaskStatements();
  const progress = stmts.progressByTaskAsc.all(row.id).map(serializeProgress);
  const comments = stmts.getTaskComments.all(row.id).map(serializeComment);
  const journal = stmts.journalByTaskAsc.all(row.id).map(serializeJournalEntry);
  const meta = parseMetadata(row.metadata);
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    status: row.status,
    priority: row.priority || 'medium',
    assigned_to: row.assigned_to,
    reviewer_agent: meta?.reviewer_agent ?? null,
    section: meta?.section ?? null,
    created_by: row.created_by,
    project_id: row.project_id,
    phase_id: row.phase_id,
    tags: parseTags(row.tags),
    metadata: meta,
    rejection_count: row.rejection_count ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
    claimed_at: row.claimed_at,
    submitted_at: row.submitted_at,
    approved_at: row.approved_at,
    deadline: row.deadline ?? null,
    result: row.result ?? null,
    progress_reports: progress,
    comments,
    journal,
  };
}
