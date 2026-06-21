/**
 * fold-engine.js — Phase-2 FOLD/REBUILD ENGINE (the lossless-rebuild gate
 * instrument). Built EXACTLY to:
 *   data/projects/cortex/docs/phase2-fold-engine-spec.md (SIGNED, A1-A6)
 *
 * READ-ONLY by contract (§1): for every task,
 *   fold(events.jsonl) + content(task.json) → assembled row
 * diffed field-for-field against a frozen baseline DB dump. This module
 * performs ZERO DB writes and ZERO folder writes — it never opens the DB at
 * all (no getDb import) and only ever fs.readFileSync's the tree.
 *
 * Column policy (§3 — every tasks column has exactly one source):
 *   FOLD (events)        : status, assigned_to, claimed_at, submitted_at,
 *                          approved_at, rejection_count, reviewer_agent
 *   FOLD explicit rule   : created_at (= task_created event ts, normalized),
 *                          created_by (= task_created data.created_by,
 *                          fallback task.json)
 *   CONTENT (task.json)  : title, description, priority, tags, section,
 *                          deadline, parent_task_id, result
 *   TRANSIENT (A5)       : lease_token, lease_expires_at — skipped for drift;
 *                          baseline active-lease assertion list instead
 *                          (any unexpired lease = gate-blocking disposition)
 *   INFRA (skip)         : fs_version, folder_path, updated_at, phase_id;
 *                          id/project_id compared for IDENTITY only
 *   metadata blob        : PROJECTED SUBSET only (section, reviewer_agent)
 *
 * Fold rules (§4): per-type transitions mirroring the live SQL in
 * statements.js (file:line cited at each rule below). MANDATORY 1a-gap
 * additions: task_cancelled AND task_reopened ⇒ assigned_to = null.
 * task_rejected count is cumulative across reopens. Equal-ts events keep
 * STABLE FILE ORDER (signed A2). Unknown event_type ⇒ HARD ERROR (signed
 * A3: gate-blocking, never silently skipped).
 *
 * Timestamps compare at SECOND precision via normTs semantics (§3). The
 * oracle stores "YYYY-MM-DD HH:MM:SS" (SQLite UTC); events store ISO-ms-Z
 * (UTC). Normalisation here is purely STRING-based (space→T, strip
 * fractional seconds + Z) — deliberately NOT Date.parse round-tripping,
 * because a non-UTC host TZ would re-interpret the zone-less DB form as
 * local time and manufacture false drift. Both forms are UTC wall-clock;
 * string normalisation compares them exactly.
 */

import fs from 'node:fs';
import path from 'node:path';
import { normIsoTs } from '@cortex/sdk/http';
import { findTaskJsonFiles, parseTaskJson } from './reconciler.js';

// ---------------------------------------------------------------------------
// Event vocabulary — derived from CODE (transitions.js + orphan.js on the
// t120-build base, per signed A1) ∪ the 1a format-spec §7 list. Every
// event_type the writers can emit, with its fold effect. Unknown type at
// fold time = HARD ERROR (A3).
//
// Source sites (t120-build):
//   transitions.js : task_created(:297) task_claimed(:374) task_resumed(:438,
//     :462) task_progressed(:545) task_submitted(:696)
//     task_review_requested(:767) task_approved(:807) task_rejected(:880)
//     task_updated(:999) task_cancelled(:1055) task_failed(:1109)
//     task_delete_requested(:1156) task_deleted(:1274)
//     task_delete_denied(:1341,:1413) task_released(:1463)
//     task_reassigned(:1520) task_commented(:1580) task_reopened(:1634)
//   orphan.js      : task_orphaned(:104) task_orphan_claimed(:238)
//   1a §7 list     : subset of the above (no extra types).
// ---------------------------------------------------------------------------

export const EVENT_VOCABULARY = Object.freeze([
  'task_created',
  'task_claimed',
  'task_resumed',
  'task_progressed',
  'task_submitted',
  'task_review_requested',
  'task_approved',
  'task_rejected',
  'task_updated',
  'task_cancelled',
  'task_failed',
  'task_delete_requested',
  'task_deleted',
  'task_delete_denied',
  'task_released',
  'task_reassigned',
  'task_commented',
  'task_reopened',
  'task_orphaned',
  'task_orphan_claimed',
]);

const VOCAB_SET = new Set(EVENT_VOCABULARY);

/** Default exempt-corrupt allowlist (signed A4: EXPLICIT ids, never
 *  patterns). These are the 3 pre-existing corrupt DB rows from the
 *  May-03/04 era (1a-format-spec §7(b)) — impossible lifecycle states no
 *  valid event sequence can produce. DEFAULTS ONLY: the CLI/options can
 *  override with another explicit list. */
export const DEFAULT_EXEMPT_CORRUPT = Object.freeze([
  'aaaaaaaa-0000-0000-0000-000000000001',
  'bbbbbbbb-0000-0000-0000-000000000002',
  'cccccccc-0000-0000-0000-000000000003',
]);

/** Pre-declared dispositions carried INTO every report (§5 — never
 *  "discovered" at run time). */
export const DISPOSITION_NOTES = Object.freeze([
  'exempt-corrupt: 3 known corrupt DB rows (aaaaaaaa, bbbbbbbb, cccccccc — impossible states predating the ledger); diff suppressed via explicit allowlist; operator decides clean-vs-carry at the gate.',
  'example-project NN!=MM audit⊃ledger parity anomaly: audit is a superset of the ledger for project example-project; no data loss (1a-format-spec §3 Class-2).',
  'out-of-scope: baseline rows with cutover_included=false (excluded projects per the P2 map rulings) are enumerated, never folded.',
  'DB-only orphans (baseline rows with no folder on disk): listed per reconciler Case-C policy (report, never delete), never folded.',
]);

// ---------------------------------------------------------------------------
// Hard-error type
// ---------------------------------------------------------------------------

/** A FoldHardError is gate-blocking (signed A3). */
export class FoldHardError extends Error {
  constructor(code, detail = {}) {
    super(`fold_hard_error:${code} ${JSON.stringify(detail)}`);
    this.name = 'FoldHardError';
    this.code = code;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Timestamp normalisation — §3 second-precision normTs semantics,
// string-based (see header for why not Date.parse).
// ---------------------------------------------------------------------------

/**
 * normTs — re-exported from sdk/http/iso.js (normIsoTs) for callers that
 * import it from fold-engine (S1 consolidation). Normalises any timestamp to
 * "YYYY-MM-DDTHH:MM:SS" (second precision, UTC wall-clock). Accepts DB
 * space-form and event ISO-Z form. Returns null for null/undefined; returns
 * the input string unchanged when it doesn't look like a timestamp so
 * garbage values drift loudly rather than collapsing to null.
 */
export const normTs = normIsoTs;

/** Parse an event ts to epoch ms for ORDERING (full ms precision; A2 ties
 *  broken by stable file order). Throws FoldHardError on unparsable ts. */
function tsEpoch(ts, ctx) {
  const epoch = Date.parse(ts);
  if (Number.isNaN(epoch)) {
    throw new FoldHardError('unparsable_event_ts', { ts, ...ctx });
  }
  return epoch;
}

// ---------------------------------------------------------------------------
// foldTask — pure fold of one task's events + task.json content
// ---------------------------------------------------------------------------

/**
 * Fold a single task. Pure + read-only: no I/O.
 *
 * @param {object[]} events    — parsed events.jsonl lines ({ts, task_id,
 *                               project_id, actor, event_type, from_status,
 *                               to_status, data}) in FILE ORDER.
 * @param {object}   taskJson  — parsed task.json (CONTENT source).
 * @param {object}   [options]
 * @param {boolean}  [options.requireTaskIdMatch=true] — hard-error when an
 *                               event's task_id ≠ taskJson.id.
 * @returns {{ row: object, deleted: boolean, eventCount: number }}
 *   row = the assembled comparison row (FOLD + FOLD-explicit + CONTENT
 *   columns, plus id/project_id identity). deleted = a task_deleted event
 *   was replayed (terminal removal marker).
 * @throws {FoldHardError} unknown event_type / unparsable ts / task_id
 *   mismatch — gate-blocking, never silently skipped (A3).
 */
export function foldTask(events, taskJson, options = {}) {
  const { requireTaskIdMatch = true } = options;
  if (!taskJson || typeof taskJson !== 'object' || !taskJson.id) {
    throw new FoldHardError('invalid_task_json', { id: taskJson?.id ?? null });
  }
  if (!Array.isArray(events)) {
    throw new FoldHardError('events_not_array', { id: taskJson.id });
  }

  // -- vocabulary + shape gate FIRST (fail loud before any folding) --------
  events.forEach((ev, i) => {
    if (!ev || typeof ev !== 'object') {
      throw new FoldHardError('invalid_event_line', { id: taskJson.id, index: i });
    }
    if (!VOCAB_SET.has(ev.event_type)) {
      throw new FoldHardError('unknown_event_type', {
        id: taskJson.id, index: i, event_type: ev.event_type ?? null,
      });
    }
    if (requireTaskIdMatch && ev.task_id && ev.task_id !== taskJson.id) {
      throw new FoldHardError('event_task_id_mismatch', {
        id: taskJson.id, index: i, event_task_id: ev.task_id,
      });
    }
  });

  // -- order: ts ascending (ms precision), STABLE file order on ties (A2) --
  // Array.prototype.sort is spec-stable; sorting by epoch keeps equal-ts
  // events in their original file order.
  const ordered = events
    .map((ev, i) => ({ ev, i, epoch: tsEpoch(ev.ts, { id: taskJson.id, index: i }) }))
    .sort((a, b) => a.epoch - b.epoch)
    .map((x) => x.ev);

  // -- replay -----------------------------------------------------------
  const st = {
    status: null,
    assigned_to: null,
    claimed_at: null,
    submitted_at: null,
    approved_at: null,
    rejection_count: 0,
    reviewer_agent: null,
    created_at: null,
    created_by: null,
    deleted: false,
  };

  for (const ev of ordered) {
    const data = (ev.data && typeof ev.data === 'object') ? ev.data : {};
    switch (ev.event_type) {
      case 'task_created':
        // statements.js createTask :50 — INSERT status='pending'.
        st.status = 'pending';
        st.created_at = normTs(ev.ts);
        // §3 explicit rule: created_by = task_created data.created_by,
        // fallback task.json (applied after replay).
        if (data.created_by != null) st.created_by = data.created_by;
        break;
      case 'task_claimed':
        // statements.js claimTask :60 — status='claimed', assigned_to=?,
        // claimed_at=now. Last claim wins (chronological replay).
        st.status = 'claimed';
        st.assigned_to = data.assigned_to ?? ev.actor ?? null;
        st.claimed_at = normTs(ev.ts);
        break;
      case 'task_resumed':
        // statements.js resumeFromClaim/:102 resumeFromReject/:104 —
        // status='in_progress' only.
        st.status = 'in_progress';
        break;
      case 'task_progressed':
        // transitions.js :534 — auto-advance claimed/rejected→in_progress is
        // carried in the event's to_status; status-neutral otherwise.
        if (ev.to_status != null) st.status = ev.to_status;
        break;
      case 'task_submitted':
        // statements.js submitTask :108 — status='submitted',
        // submitted_at=now (result is CONTENT, from task.json).
        st.status = 'submitted';
        st.submitted_at = normTs(ev.ts);
        break;
      case 'task_review_requested':
        // statements.js verifyTask :116 — status='review',
        // metadata.reviewer_agent=?.
        st.status = 'review';
        st.reviewer_agent = data.reviewer ?? data.reviewer_agent ?? null;
        break;
      case 'task_approved':
        // statements.js approveTask :123 — status='approved',
        // approved_at=now.
        st.status = 'approved';
        st.approved_at = normTs(ev.ts);
        break;
      case 'task_rejected':
        // statements.js rejectTask :131 + incrementRejectionCount :138 —
        // CUMULATIVE across reopens (§4).
        st.status = 'rejected';
        st.rejection_count += 1;
        break;
      case 'task_reopened':
        // statements.js reopenTask :143 — status='pending',
        // assigned_to=NULL (MANDATORY 1a-gap rule, §4), claimed_at=NULL,
        // json_remove reviewer_agent.
        st.status = 'pending';
        st.assigned_to = null;
        st.claimed_at = null;
        st.reviewer_agent = null;
        break;
      case 'task_released':
        // statements.js releaseTask :222 — status='pending',
        // assigned_to=NULL (§4), claimed_at=NULL, json_remove
        // reviewer_agent.
        st.status = 'pending';
        st.assigned_to = null;
        st.claimed_at = null;
        st.reviewer_agent = null;
        break;
      case 'task_reassigned':
        // statements.js reassignTask :213 — status='pending',
        // assigned_to=<new agent>, claimed_at=NULL, json_remove
        // reviewer_agent.
        st.status = 'pending';
        st.assigned_to = data.new_agent ?? null;
        st.claimed_at = null;
        st.reviewer_agent = null;
        break;
      case 'task_cancelled':
        // statements.js cancelTask :152 — status='cancelled',
        // assigned_to=NULL (MANDATORY 1a-gap rule, §4).
        st.status = 'cancelled';
        st.assigned_to = null;
        break;
      case 'task_failed':
        // statements.js failTask :165 — status='failed' (assigned_to
        // RETAINED — the SQL does not touch it).
        st.status = 'failed';
        break;
      case 'task_orphaned':
        // statements.js orphanTask :83 — status='orphaned',
        // assigned_to=NULL (claimed_at retained).
        st.status = 'orphaned';
        st.assigned_to = null;
        break;
      case 'task_orphan_claimed':
        // statements.js claimOrphanedTask :71 — status='in_progress',
        // assigned_to=?, claimed_at=now.
        st.status = 'in_progress';
        st.assigned_to = data.assigned_to ?? ev.actor ?? null;
        st.claimed_at = normTs(ev.ts);
        break;
      case 'task_deleted':
        // transitions.js :1274 — terminal row removal; the folder is renamed
        // " (deleted)". A baseline row should never coexist with this marker
        // (foldAll hard-errors on it).
        st.deleted = true;
        break;
      case 'task_updated':
      case 'task_commented':
      case 'task_delete_requested':
      case 'task_delete_denied':
        // Status-neutral by §4 (metadata/comment-only mutations; the
        // projected subset — section, reviewer_agent — is not touched by
        // these writers' SQL).
        break;
      default:
        // Unreachable (vocabulary gate above) — belt-and-braces.
        throw new FoldHardError('unknown_event_type', {
          id: taskJson.id, event_type: ev.event_type,
        });
    }
  }

  // §3 explicit rule: created_by fallback to task.json when the genesis
  // event carries none.
  if (st.created_by == null) st.created_by = taskJson.created_by ?? null;

  const row = {
    // identity (compared for identity only)
    id: taskJson.id,
    project_id: taskJson.project_id ?? null,
    // FOLD columns
    status: st.status,
    assigned_to: st.assigned_to,
    claimed_at: st.claimed_at,
    submitted_at: st.submitted_at,
    approved_at: st.approved_at,
    rejection_count: st.rejection_count,
    reviewer_agent: st.reviewer_agent,
    // FOLD w/ explicit rule
    created_at: st.created_at,
    created_by: st.created_by,
    // CONTENT columns (task.json)
    title: taskJson.title ?? '',
    description: taskJson.description ?? '',
    priority: taskJson.priority ?? 'normal',
    tags: Array.isArray(taskJson.tags) ? taskJson.tags : [],
    section: taskJson.section ?? null,
    deadline: taskJson.deadline ?? null,
    parent_task_id: taskJson.parent_task_id ?? null,
    result: taskJson.result ?? null,
  };

  return { row, deleted: st.deleted, eventCount: events.length };
}

// ---------------------------------------------------------------------------
// Field comparison — fold row vs baseline row, per the §3 column policy
// ---------------------------------------------------------------------------

function eqNull(a, b) {
  return (a ?? null) === (b ?? null);
}

function eqStrOrEmpty(a, b) {
  return (a ?? '') === (b ?? '');
}

function eqTs(a, b) {
  return normTs(a) === normTs(b);
}

function baselineTags(row) {
  if (Array.isArray(row.tags)) return row.tags;
  if (typeof row.tags === 'string') {
    try {
      const v = JSON.parse(row.tags);
      return Array.isArray(v) ? v : [];
    } catch (_) { return []; }
  }
  return [];
}

function baselineMeta(row) {
  const m = row.metadata;
  if (m && typeof m === 'object') return m;
  if (typeof m === 'string') {
    try { return JSON.parse(m) || {}; } catch (_) { return {}; }
  }
  return {};
}

/**
 * Diff one fold row against one baseline (oracle-dump) row on every policy
 * column. Returns [] on MATCH, else [{field, fold_value, baseline_value}].
 * TRANSIENT (lease_*) and INFRA (fs_version/folder_path/updated_at/phase_id)
 * fields are NEVER compared here, by §3.
 */
export function diffRow(foldRow, baselineRow) {
  const meta = baselineMeta(baselineRow);
  const diffs = [];
  const push = (field, fv, bv) => diffs.push({ field, fold_value: fv ?? null, baseline_value: bv ?? null });

  // FOLD columns
  if (!eqNull(foldRow.status, baselineRow.status)) push('status', foldRow.status, baselineRow.status);
  if (!eqNull(foldRow.assigned_to, baselineRow.assigned_to)) push('assigned_to', foldRow.assigned_to, baselineRow.assigned_to);
  if (!eqTs(foldRow.claimed_at, baselineRow.claimed_at)) push('claimed_at', foldRow.claimed_at, baselineRow.claimed_at);
  if (!eqTs(foldRow.submitted_at, baselineRow.submitted_at)) push('submitted_at', foldRow.submitted_at, baselineRow.submitted_at);
  if (!eqTs(foldRow.approved_at, baselineRow.approved_at)) push('approved_at', foldRow.approved_at, baselineRow.approved_at);
  if (Number(foldRow.rejection_count ?? 0) !== Number(baselineRow.rejection_count ?? 0)) {
    push('rejection_count', foldRow.rejection_count, baselineRow.rejection_count);
  }
  if (!eqNull(foldRow.reviewer_agent, meta.reviewer_agent)) push('reviewer_agent', foldRow.reviewer_agent, meta.reviewer_agent);

  // FOLD w/ explicit rule
  if (!eqTs(foldRow.created_at, baselineRow.created_at)) push('created_at', foldRow.created_at, baselineRow.created_at);
  if (!eqNull(foldRow.created_by, baselineRow.created_by)) push('created_by', foldRow.created_by, baselineRow.created_by);

  // CONTENT columns
  if (!eqStrOrEmpty(foldRow.title, baselineRow.title)) push('title', foldRow.title, baselineRow.title);
  if (!eqStrOrEmpty(foldRow.description, baselineRow.description)) push('description', foldRow.description, baselineRow.description);
  if (!eqNull(foldRow.priority, baselineRow.priority)) push('priority', foldRow.priority, baselineRow.priority);
  {
    const ft = JSON.stringify(foldRow.tags ?? []);
    const bt = JSON.stringify(baselineTags(baselineRow));
    if (ft !== bt) push('tags', ft, bt);
  }
  if (!eqNull(foldRow.section, meta.section)) push('section', foldRow.section, meta.section);
  if (!eqTs(foldRow.deadline, baselineRow.deadline)) push('deadline', foldRow.deadline, baselineRow.deadline);
  if (!eqNull(foldRow.parent_task_id, baselineRow.parent_task_id)) push('parent_task_id', foldRow.parent_task_id, baselineRow.parent_task_id);
  if (!eqNull(foldRow.result, baselineRow.result)) push('result', foldRow.result, baselineRow.result);

  return diffs;
}

// ---------------------------------------------------------------------------
// events.jsonl reader (read-only)
// ---------------------------------------------------------------------------

/** Read + parse a task folder's events.jsonl in FILE ORDER.
 *  @throws {FoldHardError} missing file / unreadable / bad JSON line. */
export function readEventsJsonl(taskDir, taskId) {
  const fp = path.join(taskDir, 'events.jsonl');
  let raw;
  try {
    raw = fs.readFileSync(fp, 'utf8');
  } catch (err) {
    throw new FoldHardError('events_jsonl_unreadable', {
      id: taskId, path: fp, error: err.code ?? err.message,
    });
  }
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  return lines.map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      throw new FoldHardError('events_jsonl_bad_line', { id: taskId, path: fp, line: i + 1 });
    }
  });
}

// ---------------------------------------------------------------------------
// foldAll — scan the tree, fold every in-scope baseline row, build the report
// ---------------------------------------------------------------------------

/** Snapshot of the lifecycle fields that make a corrupt row impossible —
 *  carried into the exempt listing (§5.1 "listed with their impossible
 *  fields"). */
function lifecycleSnapshot(row) {
  return {
    status: row.status ?? null,
    assigned_to: row.assigned_to ?? null,
    claimed_at: row.claimed_at ?? null,
    submitted_at: row.submitted_at ?? null,
    approved_at: row.approved_at ?? null,
    rejection_count: row.rejection_count ?? 0,
  };
}

/**
 * Run the fold over a whole projects tree against a baseline dump.
 * READ-ONLY: zero DB writes, zero folder writes — the report object is
 * returned, never written here (the CLI writes it).
 *
 * @param {string}   projectsRoot — dir whose children are project roots
 *                                  (each with a tasks/phase-N layout).
 * @param {object[]} baselineRows — frozen oracle dump rows (P1 build-oracle
 *                                  format: flat columns + parsed metadata +
 *                                  cutover_included).
 * @param {object}   [options]
 * @param {string[]} [options.exemptCorrupt=DEFAULT_EXEMPT_CORRUPT] —
 *                     EXPLICIT id allowlist (A4) for the corrupt-row
 *                     exemption; diff suppressed.
 * @param {string[]} [options.allowStale=[]] — EXPLICIT id allowlist (A4):
 *                     tasks allowed to drift vs a stale oracle; their drift
 *                     is recorded under exempt (reason stale_allowlisted),
 *                     not drift.
 * @param {number|string|Date} [options.now=Date.now()] — freeze-time for
 *                     the A5 active-lease assertion.
 * @returns {object} report object (see report.totals + report.gate_line).
 */
export function foldAll(projectsRoot, baselineRows, options = {}) {
  const exemptCorrupt = new Set(options.exemptCorrupt ?? DEFAULT_EXEMPT_CORRUPT);
  const allowStale = new Set(options.allowStale ?? []);
  const nowEpoch = options.now != null ? new Date(options.now).getTime() : Date.now();
  if (Number.isNaN(nowEpoch)) {
    throw new FoldHardError('invalid_now_option', { now: String(options.now) });
  }
  if (!Array.isArray(baselineRows)) {
    throw new FoldHardError('baseline_not_array', {});
  }

  const matches = [];
  const drifts = [];
  const exempts = [];
  const outOfScope = [];
  const hardErrors = [];
  const activeLeaseAssertions = [];
  const fsOnly = [];

  // -- disk scan (read-only; reuses the reconciler scan helpers) -----------
  const diskIndex = new Map(); // id → { taskDir, taskJsonPath, taskJson, project }
  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(projectsRoot)
      .map((name) => path.join(projectsRoot, name))
      .filter((p) => {
        try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
      })
      .sort();
  } catch (err) {
    throw new FoldHardError('projects_root_unreadable', {
      path: projectsRoot, error: err.code ?? err.message,
    });
  }

  for (const projectDir of projectDirs) {
    for (const found of findTaskJsonFiles(projectDir)) {
      const taskJson = parseTaskJson(found.taskJsonPath);
      if (!taskJson) {
        hardErrors.push({
          id: null,
          code: 'task_json_unparsable',
          detail: { path: found.taskJsonPath },
        });
        continue;
      }
      if (diskIndex.has(taskJson.id)) {
        hardErrors.push({
          id: taskJson.id,
          code: 'duplicate_task_id_on_disk',
          detail: {
            path: found.taskJsonPath,
            first_path: diskIndex.get(taskJson.id).taskJsonPath,
          },
        });
        continue;
      }
      diskIndex.set(taskJson.id, {
        taskDir: found.taskDir,
        taskJsonPath: found.taskJsonPath,
        taskJson,
        project: path.basename(projectDir),
      });
    }
  }

  // -- baseline index + duplicate check ------------------------------------
  const baselineIds = new Set();
  for (const row of baselineRows) {
    if (!row || typeof row !== 'object' || !row.id) {
      hardErrors.push({ id: null, code: 'baseline_row_invalid', detail: {} });
      continue;
    }
    if (baselineIds.has(row.id)) {
      hardErrors.push({ id: row.id, code: 'duplicate_baseline_id', detail: {} });
    }
    baselineIds.add(row.id);
  }

  // -- per-baseline-row classification (§5 order: explicit exempt allowlist
  //    FIRST — an operator's pre-declared disposition beats everything —
  //    then cutover scope, then folder presence, then fold+diff). ----------
  for (const row of baselineRows) {
    if (!row || typeof row !== 'object' || !row.id) continue; // hard-errored above

    // A5 lease assertion runs for EVERY baseline row regardless of
    // classification — the freeze-time invariant is "no active leases exist
    // in the baseline", full stop.
    if (row.lease_expires_at != null) {
      const leaseEpoch = Date.parse(row.lease_expires_at);
      if (!Number.isNaN(leaseEpoch) && leaseEpoch > nowEpoch) {
        activeLeaseAssertions.push({
          id: row.id,
          lease_token: row.lease_token ?? null,
          lease_expires_at: row.lease_expires_at,
          disposition: 'GATE-BLOCKING: active (unexpired) lease in baseline at freeze time (signed A5) — quiesce + re-freeze, or operator dispositions explicitly.',
        });
      }
    }

    if (exemptCorrupt.has(row.id)) {
      exempts.push({
        id: row.id,
        reason: 'exempt_corrupt',
        note: 'explicit allowlist (A4) — pre-existing corrupt DB row; diff suppressed; operator decides clean-vs-carry at the gate',
        impossible_fields: lifecycleSnapshot(row),
      });
      continue;
    }

    if (row.cutover_included === false) {
      outOfScope.push({ id: row.id, reason: 'cutover_excluded', title: row.title ?? null });
      continue;
    }

    const disk = diskIndex.get(row.id);
    if (!disk) {
      outOfScope.push({ id: row.id, reason: 'db_only_orphan', title: row.title ?? null });
      continue;
    }

    let folded;
    try {
      const events = readEventsJsonl(disk.taskDir, row.id);
      folded = foldTask(events, disk.taskJson, options);
    } catch (err) {
      if (err instanceof FoldHardError) {
        hardErrors.push({ id: row.id, code: err.code, detail: err.detail });
        continue;
      }
      throw err;
    }

    if (folded.deleted) {
      hardErrors.push({
        id: row.id,
        code: 'task_deleted_event_but_baseline_row_exists',
        detail: { taskDir: disk.taskDir },
      });
      continue;
    }

    // identity check (id matched via index; project_id must agree)
    if (row.project_id && folded.row.project_id && row.project_id !== folded.row.project_id) {
      hardErrors.push({
        id: row.id,
        code: 'project_id_identity_mismatch',
        detail: { fold: folded.row.project_id, baseline: row.project_id },
      });
      continue;
    }

    const diffs = diffRow(folded.row, row);
    if (diffs.length === 0) {
      matches.push({ id: row.id, events: folded.eventCount });
    } else if (allowStale.has(row.id)) {
      exempts.push({
        id: row.id,
        reason: 'stale_allowlisted',
        note: 'explicit allowlist (A4) — known post-snapshot movement vs a stale oracle',
        fields: diffs,
      });
    } else {
      drifts.push({ id: row.id, title: row.title ?? null, fields: diffs });
    }
  }

  // -- fs-only tasks (on disk, not in baseline) — parity note, listed ------
  for (const [id, disk] of diskIndex) {
    if (!baselineIds.has(id)) {
      fsOnly.push({ id, project: disk.project, taskDir: disk.taskDir });
    }
  }

  const totals = {
    tasks: baselineRows.length,
    match: matches.length,
    drift: drifts.length,
    exempt: exempts.length,
    out_of_scope: outOfScope.length,
    hard_errors: hardErrors.length,
  };

  const gateLine = `GATE: tasks=${totals.tasks} match=${totals.match} drift=${totals.drift} exempt=${totals.exempt} out_of_scope=${totals.out_of_scope} hard_errors=${totals.hard_errors}`;

  return {
    generated_at: new Date().toISOString(),
    projects_root: projectsRoot,
    baseline_count: baselineRows.length,
    disk_count: diskIndex.size,
    vocabulary: [...EVENT_VOCABULARY],
    allowlists: {
      exempt_corrupt: [...exemptCorrupt],
      allow_stale: [...allowStale],
    },
    disposition_notes: [...DISPOSITION_NOTES],
    totals,
    // Gate green ⇔ drift=0 AND hard_errors=0 (signed A3) AND no active
    // leases in the baseline (signed A5).
    gate_green: totals.drift === 0
      && totals.hard_errors === 0
      && activeLeaseAssertions.length === 0,
    gate_line: gateLine,
    matches,
    drifts,
    exempts,
    out_of_scope: outOfScope,
    hard_errors: hardErrors,
    active_lease_assertions: activeLeaseAssertions,
    fs_only: fsOnly,
  };
}
