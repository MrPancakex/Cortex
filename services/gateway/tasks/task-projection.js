/**
 * task-projection.js — pure bidirectional projection between task DB rows
 * and task.json on-disk representation (LEDGER-SCHEMA.md §2.3).
 *
 * Exports two pure functions with NO side-effects and NO I/O:
 *   - dbRowToTaskJson(taskRow, phaseNumber, projectSlug)
 *   - taskJsonToDbColumns(taskJsonObj, projectId, phaseId)
 *
 * Both functions are unit-testable in isolation (no DB, no fs).
 *
 * Timestamp normalisation: normIsoTs from sdk/http/iso.js is the SSOT for
 * the ISO-T ("YYYY-MM-DDTHH:MM:SS") form used in comparisons (S1).
 *
 * Comparison fields (for reconciler idempotency):
 *   The reconciler compares projections to detect drift. The comparison
 *   EXCLUDES `fs_version` and `folder_path` because those are reconciler-
 *   controlled metadata — fs_version is bumped by the reconciler itself on
 *   each update pass, and folder_path is set from the found path on disk.
 *   Including either in the content comparison would cause every run to
 *   re-update rows needlessly, breaking idempotency.
 *
 * NOTE on diff shape vs LEDGER-SCHEMA.md §4.3:
 *   The schema doc uses `orphaned_db_rows` / action `'orphaned_db_row'` /
 *   `changed_fields`. The user's task brief (the authoritative contract for
 *   this implementation) uses `removed` / action `'removed'` / `fields_changed`.
 *   This file implements the user's shape. The schema doc is a draft;
 *   the brief is the acceptance criterion.
 */

import { normIsoTs } from '@cortex/sdk/http';
import { parseTaskMetadata } from './_meta.js';

/**
 * Fields compared field-by-field for drift detection.
 * fs_version and folder_path are intentionally excluded — they are
 * reconciler-managed metadata, not content fields.
 *
 * @type {string[]}
 */
export const COMPARED_FIELDS = [
  'title',
  'status',
  'priority',
  'assigned_to',
  'created_by',
  'created_at',
  'updated_at',
  'claimed_at',
  'submitted_at',
  'approved_at',
  'deadline',
  'description',
  'result',
  'tags',
  'section',
  'rejection_count',
  'parent_task_id',
  'reviewer_agent',
  'lease_token',
  'lease_expires_at',
];

// -- internal helpers ---------------------------------------------------------

// parseMeta → parseTaskMetadata from ./_meta.js (S3 consolidation).
const parseMeta = parseTaskMetadata;

/** Parse tags JSON column; return [] on any failure. */
function parseTags(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch (_) {
    return [];
  }
}

// normTs → normIsoTs from sdk/http/iso.js (S1 consolidation).
// Produces "YYYY-MM-DDTHH:MM:SS" for stable field-level comparison between
// task.json timestamps (may carry .000Z) and DB datetime() values.
const normTs = normIsoTs;

const TIMESTAMP_FIELDS = new Set([
  'created_at', 'updated_at', 'claimed_at', 'submitted_at',
  'approved_at', 'deadline', 'lease_expires_at',
]);

// -- public API ---------------------------------------------------------------

/**
 * Apply fold-derived null-authoritative values to an already-built metadata JSON string.
 * FOLD-DERIVED VALUES ARE AUTHORITATIVE INCLUDING NULL (R4/R5 contract): when the fold
 * result is null (cleared by reopen/release/reassign for reviewer_agent, or cleared by
 * task_update for section), a stale metadata_blob must NOT resurrect the old value.
 *
 * THREE-STATE semantics per key:
 *   - value non-null         → set key in meta
 *   - value null (explicit)  → DELETE key from meta (matches json_remove / delete semantics)
 *   - value undefined/absent → leave the blob value untouched (backward compat for old files)
 *
 * @param {string|null} metadataJson  — current cols.metadata JSON string
 * @param {object}      overrides     — map of key→value with three-state semantics above
 *                                      recognised keys: reviewer_agent, section
 * @returns {string} updated metadata JSON string
 */
export function applyFoldOverlay(metadataJson, overrides) {
  let metaObj;
  try {
    metaObj = metadataJson ? JSON.parse(metadataJson) : {};
  } catch (_) {
    metaObj = {};
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      // absent → leave blob untouched (backward compat: old task.json omits the key)
      continue;
    } else if (value === null) {
      // explicit null → authoritative clear — remove from blob so a stale blob value
      // cannot resurrect a value the live system cleared (json_remove / delete parity).
      delete metaObj[key];
    } else {
      // non-null → set the key to the fold-derived value
      metaObj[key] = value;
    }
  }
  return JSON.stringify(metaObj);
}

/**
 * Apply fold-derived reviewer_agent to an already-built metadata JSON string.
 * Fold-derived values are AUTHORITATIVE INCLUDING NULL (F5 fix): when the fold
 * says null (because reopen/release/reassign cleared reviewer via json_remove),
 * the rebuilt metadata must NOT carry the old reviewer from a stale blob.
 *
 * @deprecated Use applyFoldOverlay({ reviewer_agent }) instead.
 *   Kept as a thin alias to avoid a broad rename across callers.
 *
 * @param {string|null} metadataJson — current cols.metadata JSON string
 * @param {string|null} foldedReviewerAgent — fold output for reviewer_agent (may be null)
 * @returns {string} updated metadata JSON string
 */
export function applyFoldReviewer(metadataJson, foldedReviewerAgent) {
  return applyFoldOverlay(metadataJson, { reviewer_agent: foldedReviewerAgent });
}

/**
 * Convert a DB tasks row to a task.json object (LEDGER-SCHEMA.md §2.3).
 *
 * @param {object} taskRow       — raw row from `SELECT * FROM tasks`
 * @param {number} phaseNumber   — 1-based phase ordinal (resolved externally)
 * @param {string} projectSlug   — slug of the project (informational; not in schema but kept for callers)
 * @returns {object}             — task.json-shaped object
 *
 * WHY metadata_blob IS PERSISTED HERE (Phase 3 R3 — ROOT D):
 *
 * Folders-as-truth requires that EVERY DB column survives a full wipe+rebuild
 * cycle with byte-identical values. The `metadata` column carries sub-fields
 * that are written by SQL json_set() calls in transitions.js (e.g. `source`,
 * `phase_number`, `review_feedback`, `reviewer_agent`) and are NOT independently
 * derivable from the fold engine alone (which only reconstructs `status`,
 * `assigned_to`, lifecycle timestamps, `rejection_count`, and `reviewer_agent`).
 *
 * Without metadata_blob, a rebuilt task only recovers {section, reviewer_agent}
 * from the task.json top-level fields — silently losing `source`, `phase_number`,
 * `review_feedback`, and any future sub-fields written by json_set(). This breaks
 * the byte-identity contract for the `metadata` column.
 *
 * OVERLAY SEMANTICS: taskJsonToDbColumns uses metadata_blob as the BASE (full
 * restoration of DB-origin sub-fields), then overlays fold-derived `reviewer_agent`
 * and `section` on top so those canonical fold values always take precedence.
 * This gives us: FULL round-trip fidelity + fold-derived values win on conflict.
 *
 * ABSENT metadata_blob (hand-authored task.json or schema_version=1 files written
 * before this change): taskJsonToDbColumns falls back to minimal reconstruction
 * from top-level fields (section + reviewer_agent), preserving backwards compat.
 */
export function dbRowToTaskJson(taskRow, phaseNumber, _projectSlug) {
  const meta = parseMeta(taskRow.metadata);
  return {
    schema_version: 1,
    id: taskRow.id,
    project_id: taskRow.project_id,
    phase_id: taskRow.phase_id ?? null,
    phase_number: phaseNumber ?? 1,
    folder_path: taskRow.folder_path ?? null,
    title: taskRow.title ?? '',
    status: taskRow.status ?? 'pending',
    priority: taskRow.priority ?? 'normal',
    assigned_to: taskRow.assigned_to ?? null,
    created_by: taskRow.created_by ?? 'system',
    created_at: taskRow.created_at ?? null,
    updated_at: taskRow.updated_at ?? null,
    claimed_at: taskRow.claimed_at ?? null,
    submitted_at: taskRow.submitted_at ?? null,
    approved_at: taskRow.approved_at ?? null,
    deadline: taskRow.deadline ?? null,
    description: taskRow.description ?? '',
    result: taskRow.result ?? null,
    tags: parseTags(taskRow.tags),
    section: meta.section ?? null,
    rejection_count: taskRow.rejection_count ?? 0,
    parent_task_id: taskRow.parent_task_id ?? null,
    reviewer_agent: meta.reviewer_agent ?? null,
    provider: null, // Slice B adds this column
    lease_token: taskRow.lease_token ?? null,
    lease_expires_at: taskRow.lease_expires_at ?? null,
    fs_version: taskRow.fs_version ?? 0,
    // ROOT D (F6/F8): persist the full raw metadata blob so bootRebuild can
    // restore DB-resident metadata sub-fields (source, phase_number,
    // review_feedback, etc.) that are set by SQL json_set() calls and NOT
    // derivable from the fold engine alone. Without this, rebuilt tasks only
    // recover {section, reviewer_agent} — losing source/phase_number/review_feedback.
    // taskJsonToDbColumns uses metadata_blob as the base when present, then
    // overlays fold-derived reviewer_agent on top.
    metadata_blob: Object.keys(meta).length > 0 ? meta : undefined,
  };
}

/**
 * Convert a task.json object to the column values for an UPSERT into `tasks`.
 * Returns an object whose keys match tasks table column names.
 *
 * Fields NOT included (derived / reconciler-managed):
 *   - fs_version (passed explicitly by the reconciler as the file's value; not
 *     included here because the insert path passes it directly and the update
 *     path uses the parsed taskJson.fs_version at the call site — see reconciler.js)
 *   - folder_path (set from the actual on-disk path, not from file content)
 *
 * @param {object} taskJsonObj  — parsed task.json content
 * @param {string} projectId    — project UUID (cross-check vs taskJsonObj.project_id)
 * @param {string|null} phaseId — resolved phase UUID (may be null)
 * @returns {object}            — column map for tasks UPSERT
 *
 * WHY metadata_blob IS THE BASE (Phase 3 R3 — ROOT D — overlay semantics):
 *
 * When task.json was written by dbRowToTaskJson (the normal live-write path), it
 * carries `metadata_blob` = the full DB metadata object at write time. Using this
 * as the base restores ALL DB-resident sub-fields (source, phase_number,
 * review_feedback, etc.) that were written by SQL json_set() in transitions.js
 * and are NOT independently derivable by the fold engine.
 *
 * The fold-derived values (`reviewer_agent`, `section`) are overlaid on top so
 * they always reflect the authoritative fold result even if the metadata_blob
 * was written before the last reviewer assignment. This prevents stale cached
 * values from winning over the live event-derived state.
 *
 * BACKWARDS COMPAT (absent metadata_blob path): hand-authored task.json files
 * and schema_version=1 files written before this change will NOT carry
 * metadata_blob. In that case `meta` starts as {} and only `section` +
 * `reviewer_agent` are populated from top-level fields — the same minimal
 * reconstruction that existed before R3. No old file breaks; the absence
 * path is tested explicitly in the acceptance suite.
 */
export function taskJsonToDbColumns(taskJsonObj, projectId, phaseId) {
  // ROOT D (F6/F8): if the task.json was written by dbRowToTaskJson and carries
  // a metadata_blob, use it as the base (it holds the full metadata column blob
  // including DB-resident sub-fields like source, phase_number, review_feedback).
  // Then overlay fold-derived fields (reviewer_agent, section) on top so they
  // are always current. Without metadata_blob, fall back to the minimal {section,
  // reviewer_agent} reconstruction (used for hand-authored task.json files and
  // schema_version=1 files that predate metadata_blob).
  let meta;
  if (taskJsonObj.metadata_blob && typeof taskJsonObj.metadata_blob === 'object') {
    // Carry the full blob, then overlay top-level task.json fields on top.
    meta = { ...taskJsonObj.metadata_blob };
  } else {
    meta = {};
  }
  // Three-state overlay for fold/content-derived keys (R5 — null-authoritative):
  //   key PRESENT + non-null → set (new/updated value)
  //   key PRESENT + null     → DELETE from meta (authoritative clear — stale blob must not win)
  //   key ABSENT             → leave blob untouched (backward compat: old hand-authored files)
  //
  // 'section' in taskJsonObj distinguishes an explicit section:null (cleared) from the key
  // simply not existing in old pre-R3 hand-authored task.json files.
  // dbRowToTaskJson always writes section:null when meta.section is absent, so round-trip
  // files always carry the key explicitly — the absent path is only for hand-authored files.
  if ('section' in taskJsonObj) {
    if (taskJsonObj.section != null) meta.section = taskJsonObj.section;
    else delete meta.section; // explicit null → authoritative clear (parity with live delete)
  }
  if ('reviewer_agent' in taskJsonObj) {
    if (taskJsonObj.reviewer_agent != null) meta.reviewer_agent = taskJsonObj.reviewer_agent;
    else delete meta.reviewer_agent; // explicit null → authoritative clear
  }

  return {
    id: taskJsonObj.id,
    project_id: projectId ?? taskJsonObj.project_id,
    phase_id: phaseId ?? taskJsonObj.phase_id ?? null,
    title: taskJsonObj.title ?? '',
    description: taskJsonObj.description ?? '',
    status: taskJsonObj.status ?? 'pending',
    priority: taskJsonObj.priority ?? 'normal',
    assigned_to: taskJsonObj.assigned_to ?? null,
    created_by: taskJsonObj.created_by ?? 'system',
    created_at: taskJsonObj.created_at ?? null,
    updated_at: taskJsonObj.updated_at ?? null,
    claimed_at: taskJsonObj.claimed_at ?? null,
    submitted_at: taskJsonObj.submitted_at ?? null,
    approved_at: taskJsonObj.approved_at ?? null,
    deadline: taskJsonObj.deadline ?? null,
    result: taskJsonObj.result ?? null,
    tags: JSON.stringify(taskJsonObj.tags ?? []),
    metadata: JSON.stringify(meta),
    rejection_count: taskJsonObj.rejection_count ?? 0,
    parent_task_id: taskJsonObj.parent_task_id ?? null,
    lease_token: taskJsonObj.lease_token ?? null,
    lease_expires_at: taskJsonObj.lease_expires_at ?? null,
  };
}

/**
 * Extract the comparable content subset from a task.json object.
 * Used by the reconciler to detect whether a DB row differs from fs.
 * Returns a plain object with only the COMPARED_FIELDS keys.
 *
 * @param {object} taskJsonObj
 * @returns {object}
 */
export function comparableFields(taskJsonObj) {
  const out = {};
  for (const field of COMPARED_FIELDS) {
    const v = taskJsonObj[field];
    if (Array.isArray(v)) {
      // Normalise arrays to JSON strings for stable comparison.
      out[field] = JSON.stringify(v);
    } else if (TIMESTAMP_FIELDS.has(field)) {
      // Normalise timestamps to second-precision to bridge fs (ISO Z) vs DB (no Z, no ms).
      out[field] = normTs(v);
    } else {
      out[field] = v ?? null;
    }
  }
  return out;
}
