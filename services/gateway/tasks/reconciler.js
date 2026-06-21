/**
 * reconciler.js — Filesystem → Database reconciler for the Cortex task ledger.
 *
 * Implements LEDGER-SCHEMA.md §4 (Reconciler Contract) exactly:
 *   - Filesystem is the source of truth. DB is the derived index.
 *   - fs wins on field-level conflicts when task.json.fs_version >= tasks.fs_version.
 *   - DB-only rows (orphans) are logged but NEVER auto-deleted (Slice A policy).
 *   - Idempotent: second run with no fs changes produces zero writes.
 *   - Dry-run: computes diff without any DB mutations.
 *
 * NOTE on diff shape (schema vs task brief divergence):
 *   LEDGER-SCHEMA.md §4.3 uses "orphaned_db_rows" / action "orphaned_db_row" /
 *   "changed_fields". The task brief (authoritative acceptance criterion) uses
 *   "removed" / action "removed" / "fields_changed". This module implements
 *   the task brief's shape. See COMPARED_FIELDS in task-projection.js for
 *   which fields are compared (fs_version and folder_path are excluded).
 *
 * NOTE on parity repair:
 *   Schema §4.2 step 6 says to auto-backfill missing audit_log rows from
 *   excess ledger lines (Case B recovery). The task brief says "log it but
 *   don't throw — Phase 8 will decide". No auto-backfill in Phase 5.
 *
 * NOTE on swallow_counter:
 *   The brief mentions a "swallow_counter" for DB-only orphan rows. No global
 *   counter exists in this codebase. Orphans are recorded in the diff's
 *   per-project "removed" count and logged via console.warn.
 */

import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getDb } from '@cortex/sdk/db';
import { normSqliteTs } from '@cortex/sdk/http';
import { getTaskStatements } from './statements.js';
import { getProjectDir } from './folders.js';
import { dbRowToTaskJson, taskJsonToDbColumns, comparableFields, applyFoldOverlay } from './task-projection.js';
import { foldTask, readEventsJsonl } from './fold-engine.js';

// -- fs helpers ---------------------------------------------------------------

/** Count non-empty lines in a file; returns 0 if the file does not exist. */
function countLines(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.split('\n').filter((l) => l.trim().length > 0).length;
  } catch (_) {
    return 0;
  }
}

/**
 * Walk <projectDir>/tasks/phase-* and collect every task.json absolute path.
 * Skips directories ending in ' (deleted)'.
 *
 * @param {string} projectDir — absolute path to the project root
 * @returns {{ taskJsonPath: string, phaseNumber: number, taskDir: string }[]}
 *
 * Exported for reuse by fold-engine.js (Phase-2 fold/rebuild gate instrument).
 * The export is additive — reconcile-path behaviour is unchanged.
 */
export function findTaskJsonFiles(projectDir) {
  const tasksRoot = path.join(projectDir, 'tasks');
  const results = [];

  let phaseDirs;
  try {
    phaseDirs = fs.readdirSync(tasksRoot);
  } catch (_) {
    return results;
  }

  for (const phaseEntry of phaseDirs) {
    // Only process directories matching "phase-N"
    const phaseMatch = phaseEntry.match(/^phase-(\d+)$/);
    if (!phaseMatch) continue;
    const phaseNumber = parseInt(phaseMatch[1], 10);
    const phaseDir = path.join(tasksRoot, phaseEntry);

    let taskEntries;
    try {
      taskEntries = fs.readdirSync(phaseDir);
    } catch (_) {
      continue;
    }

    for (const taskEntry of taskEntries) {
      // Skip deleted folders
      if (taskEntry.endsWith(' (deleted)')) continue;

      const taskDir = path.join(phaseDir, taskEntry);
      try {
        if (!fs.statSync(taskDir).isDirectory()) continue;
      } catch (_) {
        continue;
      }

      const taskJsonPath = path.join(taskDir, 'task.json');
      if (fs.existsSync(taskJsonPath)) {
        results.push({ taskJsonPath, phaseNumber, taskDir });
      }
    }
  }

  return results;
}

/**
 * Parse a task.json file; return null on any I/O or parse failure.
 * Also filters out files with unrecognised schema_version (per §7.5).
 *
 * Exported for reuse by fold-engine.js (Phase-2 fold/rebuild gate instrument).
 * The export is additive — reconcile-path behaviour is unchanged.
 */
export function parseTaskJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    if (obj.schema_version !== 1) {
      console.warn(`[reconciler] unknown schema_version in ${filePath}: ${obj.schema_version}`);
      return null;
    }
    if (!obj.id) return null;
    return obj;
  } catch (err) {
    console.warn(`[reconciler] failed to parse ${filePath}: ${err.message}`);
    return null;
  }
}

// -- phase resolution ---------------------------------------------------------

/**
 * Resolve a phase_id for a given project + 1-based phase number.
 * If no matching phase row exists, creates one (required by test #10).
 *
 * @param {string} projectId
 * @param {number} phaseNumber — 1-based
 * @param {boolean} dryRun — if true, returns null instead of creating
 * @returns {string|null} phase UUID
 */
export function resolveOrCreatePhaseId(projectId, phaseNumber, dryRun) {
  const stmts = getTaskStatements();
  const ordinal = phaseNumber - 1; // phases.ordinal is 0-based
  const existing = stmts.getPhaseByOrdinal.get(projectId, ordinal);
  if (existing) return existing.id;

  if (dryRun) return null;

  // Create the missing phase row
  const phaseId = randomUUID();
  stmts.createPhase.run(phaseId, projectId, `Phase ${phaseNumber}`, ordinal);
  return phaseId;
}

// -- field-level comparison ---------------------------------------------------

/**
 * Compare two task.json-shaped objects for content drift.
 * Returns an array of field names that differ. Empty array = no drift.
 * fs_version and folder_path are excluded (reconciler-managed).
 *
 * @param {object} fromFs  — task.json content from disk
 * @param {object} fromDb  — dbRowToTaskJson() result
 * @returns {string[]}     — names of fields that differ
 */
function diffFields(fromFs, fromDb) {
  const fsCompare = comparableFields(fromFs);
  const dbCompare = comparableFields(fromDb);
  return Object.keys(fsCompare).filter((k) => {
    // Normalise null vs undefined
    const fv = fsCompare[k] ?? null;
    const dv = dbCompare[k] ?? null;
    return fv !== dv;
  });
}

// -- per-project reconcile ----------------------------------------------------

/**
 * Reconcile one project's filesystem against its DB rows.
 *
 * @param {object} project   — row from SELECT * FROM projects
 * @param {object} opts
 * @param {boolean} opts.dryRun
 * @returns {object}         — per-project diff record
 */
async function reconcileProject(project, { dryRun = false } = {}) {
  const stmts = getTaskStatements();
  const projectDir = getProjectDir(project);

  const projectResult = {
    project_id: project.id,
    slug: project.slug || project.name || project.id,
    added: 0,
    updated: 0,
    removed: 0,
    parity_ok: true,
    tasks: [],
  };

  // Skip projects whose directory doesn't exist on disk
  if (!projectDir || !fs.existsSync(projectDir)) {
    return projectResult;
  }

  // Step 2-4: find task.json files, parse, compare against DB
  const fsEntries = findTaskJsonFiles(projectDir);
  const seenTaskIds = new Set();

  for (const { taskJsonPath, phaseNumber, taskDir } of fsEntries) {
    const taskJson = parseTaskJson(taskJsonPath);
    if (!taskJson) continue;

    const taskId = taskJson.id;
    seenTaskIds.add(taskId);

    const dbRow = stmts.getTask.get(taskId);

    if (!dbRow) {
      // Case: fs only → INSERT
      projectResult.added++;
      projectResult.tasks.push({
        task_id: taskId,
        action: 'added',
        fields_changed: [],
      });

      if (!dryRun) {
        const phaseId = resolveOrCreatePhaseId(project.id, phaseNumber, dryRun);
        const cols = taskJsonToDbColumns(taskJson, project.id, phaseId);
        stmts.upsertTaskFromFs.run(
          cols.id,
          cols.project_id,
          cols.phase_id,
          cols.title,
          cols.description,
          cols.status,
          cols.priority,
          cols.assigned_to,
          cols.created_by,
          cols.tags,
          cols.metadata,
          cols.result,
          cols.rejection_count,
          cols.parent_task_id,
          cols.lease_token,
          cols.lease_expires_at,
          cols.created_at,
          cols.updated_at,
          cols.claimed_at,
          cols.submitted_at,
          cols.approved_at,
          cols.deadline,
          taskDir,           // folder_path = current found path
          taskJson.fs_version ?? 0, // fs_version from file (INSERT: start here)
        );
      }
    } else {
      // Case: both present — compare content
      const dbFsVersion = dbRow.fs_version ?? 0;
      const fileFsVersion = taskJson.fs_version ?? 0;

      // If DB is strictly ahead of the file, skip (§4.2 step 4)
      if (dbFsVersion > fileFsVersion) {
        // DB is more recent; content comparison not needed
        continue;
      }

      // fs_version >= db version: run content comparison
      const phaseId = resolveOrCreatePhaseId(project.id, phaseNumber, dryRun);
      const dbAsJson = dbRowToTaskJson(dbRow, phaseNumber, null);
      const changed = diffFields(taskJson, dbAsJson);

      if (changed.length > 0) {
        projectResult.updated++;
        projectResult.tasks.push({
          task_id: taskId,
          action: 'updated',
          fields_changed: changed,
        });

        if (!dryRun) {
          const cols = taskJsonToDbColumns(taskJson, project.id, phaseId);
          stmts.updateTaskFromFs.run(
            cols.phase_id,
            cols.title,
            cols.description,
            cols.status,
            cols.priority,
            cols.assigned_to,
            cols.created_by,
            cols.tags,
            cols.metadata,
            cols.result,
            cols.rejection_count,
            cols.parent_task_id,
            cols.lease_token,
            cols.lease_expires_at,
            cols.created_at,
            cols.updated_at,
            cols.claimed_at,
            cols.submitted_at,
            cols.approved_at,
            cols.deadline,
            taskDir,                   // folder_path = current found path (?21)
            taskJson.fs_version ?? 0,  // fs_version mirrors file (?22 — not incremented)
            taskId,                    // WHERE id = ?23
          );
        }
      }
      // else: no drift, do nothing (idempotency preserved)
    }
  }

  // Step 5: find DB-only rows (orphans)
  const dbTasks = stmts.listTasksByProject.all(project.id);
  for (const dbRow of dbTasks) {
    if (seenTaskIds.has(dbRow.id)) continue;

    // DB row has no task.json on disk — check if it's a (deleted) folder
    // We check folder_path if available; if no folder_path, treat as orphan
    const fp = dbRow.folder_path;
    if (fp && (fp.endsWith(' (deleted)') || fp.endsWith('(deleted)'))) {
      // Correctly deleted — skip (the row will be cleaned by hardDeleteTask)
      continue;
    }

    // Orphan: log it, do NOT delete
    projectResult.removed++;
    projectResult.tasks.push({
      task_id: dbRow.id,
      action: 'removed',
      fields_changed: [],
    });
    // swallow_counter: no global counter exists; log via console.warn
    console.warn(
      `[reconciler] orphan DB row: task_id=${dbRow.id} project_id=${project.id}` +
      ` — no task.json on disk; not auto-deleted (Slice A policy)`,
    );
  }

  // Step 6: parity check (§2.7) — ledger.jsonl lines vs audit_log rows
  const ledgerPath = path.join(projectDir, 'ledger.jsonl');
  const ledgerCount = countLines(ledgerPath);
  const auditCount = stmts.countAuditForProject.get(project.id)?.n ?? 0;

  if (ledgerCount !== auditCount) {
    projectResult.parity_ok = false;
    // Log but do NOT throw (Phase 8 will decide what to do)
    console.warn(
      `[reconciler] parity failure for project ${project.id}: ` +
      `ledger.jsonl lines=${ledgerCount}, audit_log rows=${auditCount}`,
    );
  }

  return projectResult;
}

// -- boot rebuild (D1) --------------------------------------------------------

/**
 * Return true when the task plane (tasks table) is empty.
 * Used by scanAll + bootRebuild to detect rebuild mode.
 */
export function isTaskPlaneEmpty() {
  const stmts = getTaskStatements();
  const row = stmts.countTasks?.get() ?? null;
  if (row) return row.n === 0;
  // Fallback if countTasks is not in statements yet: direct query.
  const db = getDb();
  const r = db.prepare('SELECT COUNT(*) AS n FROM tasks').get();
  return (r?.n ?? 0) === 0;
}

/**
 * Parse a project.json file from a project root directory.
 * Returns null on parse failure or missing schema_version.
 */
function parseProjectJson(projectDir) {
  const fp = path.join(projectDir, 'project.json');
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || !obj.id) return null;
    return obj;
  } catch (_) {
    return null;
  }
}

/**
 * Synthesize an audit_log row from a single events.jsonl event line.
 *
 * PAYLOAD SHAPE: The live dualWrite path calls:
 *   insertAudit(id, task_id, project_id, actor, event_type,
 *               JSON.stringify({ title: taskRow.title, ...data }))
 * where `data` is the extra payload passed to dualWrite — it does NOT contain
 * from_status / to_status (those are top-level event fields, not payload fields).
 * getAudit promotes from_status / to_status FROM the payload only when present;
 * since live rows never have them in payload, rebuilt rows must not inject them
 * either. Payload = JSON.stringify(ev.data ?? {}) — exactly the { title, ...data }
 * blob that was in the event data field.
 *
 * ID: audit_log row ids are random UUIDs assigned at insert time by the live
 * path and are NOT persisted in events.jsonl. They are storage-internal;
 * nothing downstream keys on a specific rebuilt row's id. The rebuilt id is
 * also a fresh randomUUID; tests must exclude id from byte-identity comparison
 * (see AUDIT-REBUILD-ID-CAVEAT below).
 *
 * TIMESTAMP SHAPE: The live insertAudit omits created_at so SQLite defaults to
 * datetime('now') = "YYYY-MM-DD HH:MM:SS" (space separator, no T, no Z).
 * Rebuilt rows must use the same shape. normTsForAudit() returns SQLite space-form.
 *
 * AUDIT-REBUILD-ID-CAVEAT: rebuilt audit_log row ids are fresh random UUIDs and
 * will differ from the original live ids (which are not persisted in the folder
 * trail). Callers verifying byte-identity of the audit trail must compare all
 * fields EXCEPT id (actor, event_type, payload, created_at, task_id, project_id).
 *
 * AUDIT-REBUILD CAVEAT: rowid tie-breaking for same-second events may differ
 * from the original live insertion order. For any task without same-second
 * events the rebuilt rows are byte-identical on all fields except id.
 *
 * @param {object} ev   — parsed events.jsonl event line
 * @param {string} sqliteCreatedAt — SQLite space-form "YYYY-MM-DD HH:MM:SS"
 * @returns {object} { id, task_id, project_id, actor, event_type, payload, created_at }
 */
export function auditRowFromEvent(ev, sqliteCreatedAt) {
  // ev.data = { title, ...extraData } — exactly the payload shape insertAudit stores.
  // Do NOT inject from_status / to_status (top-level event fields, not payload fields).
  const data = (ev.data && typeof ev.data === 'object') ? ev.data : {};
  return {
    id: randomUUID(),
    task_id: ev.task_id,
    project_id: ev.project_id,
    actor: ev.actor ?? 'system',
    event_type: ev.event_type,
    payload: JSON.stringify(data),
    created_at: sqliteCreatedAt,
  };
}

/**
 * normTsForAudit — re-export of the canonical SQLite space-form normaliser
 * from sdk/http/iso.js (normSqliteTs). Kept as a named export so existing
 * importers (_internals.js) do not need touching on this pass.
 *
 * Normalise ts to SQLite "YYYY-MM-DD HH:MM:SS" form (space separator, second
 * precision, UTC). This matches the datetime('now') format SQLite uses for the
 * live insertAudit created_at default, so rebuilt audit rows are byte-identical
 * on the created_at field.
 */
const normTsForAudit = normSqliteTs;
export { normTsForAudit };

/**
 * ROOT 1 (R7): Pure planning phase for the boot-rebuild path.
 * Scans projectsRoot (steps 1-3) and returns the discovered plans plus any
 * hard errors — WITHOUT touching the DB. Called by both bootRebuild (which
 * then commits the plan transactionally) and by the dryRun preflight inside
 * scanAll (which validates the plan and returns without writing anything).
 *
 * @param {string} projectsRoot
 * @returns {{ projectPlan, phasePlan, workPlan, hardErrors, warnings }}
 */
function _planBootRebuild(projectsRoot) {
  const hardErrors = [];
  const warnings = [];

  // -- Step 1: Scan project directories (outside transaction) ------------------
  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(projectsRoot)
      .map((name) => path.join(projectsRoot, name))
      .filter((p) => {
        try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
      })
      .sort();
  } catch (err) {
    hardErrors.push({ code: 'projects_root_unreadable', detail: { path: projectsRoot, error: err.message } });
    return { projectPlan: [], phasePlan: [], workPlan: [], hardErrors, warnings };
  }

  // -- Step 2: Build project/phase plan INDEPENDENTLY of task discovery --------
  // ROOT C (F3/F9): Every project.json → projectPlan entry. Every phase-N dir
  // under each project → phasePlan entry. This runs BEFORE task discovery so
  // an empty project (no tasks) and an empty phase dir (no task.json files) both
  // get their rows upserted in the transaction below.
  //
  // ROOT D (F4): phase_id is a synthetic FK; phases wiped+recreated get new UUIDs.
  // Tasks end up in the correct phase by number; the phase_id UUID may differ.
  const projectPlan = []; // { projJson, projectDir }
  const phasePlan = [];   // { projJson, phaseNumber, phaseDir }

  for (const projectDir of projectDirs) {
    const projJson = parseProjectJson(projectDir);
    if (!projJson) {
      warnings.push({ code: 'no_project_json', path: projectDir });
      continue;
    }
    projectPlan.push({ projJson, projectDir });

    // Scan every phase-N directory for this project
    const tasksRoot = path.join(projectDir, 'tasks');
    let phaseEntries;
    try {
      phaseEntries = fs.readdirSync(tasksRoot);
    } catch (_) {
      phaseEntries = [];
    }
    for (const phaseEntry of phaseEntries) {
      const phaseMatch = phaseEntry.match(/^phase-(\d+)$/);
      if (!phaseMatch) continue;
      const phaseNumber = parseInt(phaseMatch[1], 10);
      const phaseDir = path.join(tasksRoot, phaseEntry);
      try {
        if (!fs.statSync(phaseDir).isDirectory()) continue;
      } catch (_) { continue; }
      phasePlan.push({ projJson, phaseNumber, phaseDir });
    }
  }

  // -- Step 3: Pre-fold all tasks (outside transaction) -----------------------
  // Collect work plan; any fold hard error pushes to hardErrors.
  // ROOT 2 (R7): corrupt task.json → hardErrors (not warnings); abort before DB.
  const workPlan = []; // { projJson, taskJson, folded, events, phaseNumber, taskDir }

  for (const { projJson, phaseDir, phaseNumber } of phasePlan) {
    let taskEntries;
    try {
      taskEntries = fs.readdirSync(phaseDir);
    } catch (_) {
      taskEntries = [];
    }
    for (const taskEntry of taskEntries) {
      if (taskEntry.endsWith(' (deleted)')) continue;
      const taskDir = path.join(phaseDir, taskEntry);
      try {
        if (!fs.statSync(taskDir).isDirectory()) continue;
      } catch (_) { continue; }

      const taskJsonPath = path.join(taskDir, 'task.json');
      if (!fs.existsSync(taskJsonPath)) continue;

      const taskJson = parseTaskJson(taskJsonPath);
      if (!taskJson) {
        // ROOT 2 (R7): corrupt task.json is a HARD ERROR — not a skippable warning.
        // A corrupt task.json makes the task unrebuildable; silently skipping it
        // would commit a partial plane and prevent future flagged boots from retrying
        // (the plane is no longer empty). Abort before any DB write.
        hardErrors.push({
          code: 'task_json_parse_failed',
          path: taskJsonPath,
          project: projJson.id,
          phase: phaseNumber,
        });
        continue;
      }

      let folded;
      let events;
      try {
        events = readEventsJsonl(taskDir, taskJson.id);
        folded = foldTask(events, taskJson);
      } catch (err) {
        hardErrors.push({ code: err.code ?? 'fold_error', id: taskJson.id, detail: { error: err.message } });
        continue;
      }

      if (folded.deleted) {
        warnings.push({ code: 'task_deleted_skipped', id: taskJson.id });
        continue;
      }

      workPlan.push({ projJson, taskJson, folded, events, phaseNumber, taskDir });
    }
  }

  return { projectPlan, phasePlan, workPlan, hardErrors, warnings };
}

/**
 * Boot rebuild: scan projectsRoot for project.json files, upsert projects →
 * phases → tasks (fold engine) → audit_log (synthesized from events.jsonl).
 *
 * FK ORDER: projects BEFORE phases BEFORE tasks BEFORE audit_log.
 *
 * Called by composer.js when CORTEX_BOOT_REBUILD=1 AND the task plane is empty.
 * Returns a rebuild report: { projects_added, phases_added, tasks_added,
 * audit_added, hard_errors[], warnings[] }.
 *
 * ROOT 1 (R7): factored into _planBootRebuild (pure) + commit (transactional)
 * so the dryRun preflight inside scanAll can reuse the same planning+fold
 * passes without touching the DB.
 *
 * @param {string} projectsRoot — absolute path to the projects directory
 * @returns {object} rebuild report
 */
export async function bootRebuild(projectsRoot) {
  const stmts = getTaskStatements();
  const db = getDb();

  // ROOT C + CLUSTER C: The entire DB mutation runs in ONE db.transaction so any
  // upsert failure rolls back to an empty task plane. A partially-failed rebuild
  // never leaves a non-empty plane for the next flagged boot to skip.
  // Pre-scan (fs reads) happens outside the transaction via _planBootRebuild;
  // hard errors from fold abort before any DB write.

  let projectsAdded = 0;
  let phasesAdded = 0;
  let tasksAdded = 0;
  let auditAdded = 0;

  // Steps 1-3: pure planning (no DB writes)
  const { projectPlan, phasePlan, workPlan, hardErrors, warnings } =
    _planBootRebuild(projectsRoot);

  // CLUSTER C: any hard error (projects_root_unreadable, task_json_parse_failed,
  // or fold error) → abort before touching DB.
  if (hardErrors.length > 0) {
    return { projects_added: 0, phases_added: 0, tasks_added: 0, audit_added: 0, hard_errors: hardErrors, warnings };
  }

  // -- Step 4: All-or-nothing DB transaction -----------------------------------
  // Order: projects → phases → tasks → audit_log, all in one atomic write.
  // ROOT C: projects and phases are upserted from the plan FIRST, THEN tasks.
  // This ensures empty projects and empty phases get rows even when there are
  // no tasks in them. Failure rolls back to empty plane; next flagged boot retries.
  try {
    db.transaction(() => {
      // ---- 4a. Upsert ALL project rows (independent of tasks) ----------------
      // ROOT C (F3/F9): every project.json → project row, regardless of tasks.
      for (const { projJson } of projectPlan) {
        const projectId = projJson.id;
        const projectName = projJson.name ?? path.basename(projJson.root_path ?? projectId);
        if (!stmts.getProject.get(projectId)) {
          db.prepare(
            `INSERT OR IGNORE INTO projects (id, name, description, root_path, metadata, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            projectId,
            projectName,
            projJson.description ?? '',
            projJson.root_path ?? projectId,
            JSON.stringify(projJson.metadata ?? {}),
            projJson.created_at ?? new Date().toISOString(),
            projJson.updated_at ?? new Date().toISOString(),
          );
          projectsAdded++;
        }
      }

      // ---- 4b. Upsert ALL phase rows (independent of tasks) ------------------
      // ROOT C (F3/F9): every phase-N directory → phase row, regardless of tasks.
      // ROOT D (F4): phase_id is EXCLUDED from byte-identity comparison because
      // phases wiped+recreated get new UUIDs; phase_number/meaning is preserved
      // (tasks end up in the correct ordinal phase). The exclusion is justified:
      // there is no durable phase-UUID source in the folder trail (Phase 4 authority
      // semantics are out-of-scope; carve to Task 130).
      for (const { projJson, phaseNumber } of phasePlan) {
        const projectId = projJson.id;
        const phaseOrdinal = phaseNumber - 1;
        if (!stmts.getPhaseByOrdinal.get(projectId, phaseOrdinal)) {
          const phaseId = resolveOrCreatePhaseId(projectId, phaseNumber, false);
          if (phaseId) phasesAdded++;
        }
      }

      // ---- 4c. Upsert task rows and audit_log --------------------------------
      for (const { projJson, taskJson, folded, events, phaseNumber, taskDir } of workPlan) {
        const projectId = projJson.id;

        const phaseId = resolveOrCreatePhaseId(projectId, phaseNumber, false);

        // Build task DB columns from task.json (the durable folder source).
        const cols = taskJsonToDbColumns(taskJson, projectId, phaseId);

        // Override lifecycle columns with fold-derived values (signed column policy §3).
        // Fold establishes WHICH lifecycle state the task is in; task.json provides the
        // TIMESTAMPS (already in SQLite space-form "YYYY-MM-DD HH:MM:SS" — they were
        // written by dbRowToTaskJson when the live DB committed the transition).
        //
        // ROOT D (F6/F8): timestamps MUST be sourced from task.json's live SQLite-form
        // values, NOT from event.ts conversions. The live writer flow is:
        //   1. transitions.js calls dualWrite(taskId, event) which:
        //      a. updates the tasks row (SQLite datetime('now') → "YYYY-MM-DD HH:MM:SS")
        //      b. SEPARATELY creates event_ts = new Date().toISOString() → ISO-Z form
        //   2. syncFiles then calls dbRowToTaskJson(taskRow, ...) → copies the SQLite
        //      "YYYY-MM-DD HH:MM:SS" value directly into task.json.
        // Therefore event.ts and the DB timestamp are from SEPARATE JS Date calls and
        // may differ by up to a second across a second boundary. task.json.updated_at
        // IS the original DB value; event.ts is a DIFFERENT, slightly-earlier value.
        // Using event.ts to reconstruct updated_at produces a timestamp that doesn't
        // match what the DB stored — breaking byte identity even with identical seconds
        // under second-boundary skew. Use task.json.updated_at as the primary source.
        cols.status          = folded.row.status ?? cols.status;
        cols.assigned_to     = folded.row.assigned_to ?? null;
        // Lifecycle timestamps: prefer task.json (exact DB-origin values) over fold output.
        // normSqliteTs normalises any T-form residual; task.json is already space-form.
        cols.claimed_at      = normSqliteTs(taskJson.claimed_at ?? folded.row.claimed_at) ?? null;
        cols.submitted_at    = normSqliteTs(taskJson.submitted_at ?? folded.row.submitted_at) ?? null;
        cols.approved_at     = normSqliteTs(taskJson.approved_at ?? folded.row.approved_at) ?? null;
        cols.rejection_count = folded.row.rejection_count ?? 0;
        // created_at and updated_at: exact task.json values (written from DB row by dbRowToTaskJson).
        // Fall back to fold output only when task.json has no value.
        cols.created_at      = normSqliteTs(taskJson.created_at ?? folded.row.created_at) ?? cols.created_at;
        cols.created_by      = folded.row.created_by ?? cols.created_by;
        // updated_at: task.json is THE authoritative source — it holds the exact SQLite-form
        // value written after the last live DB write. Do NOT use event.ts (see ROOT D above).
        cols.updated_at      = normSqliteTs(taskJson.updated_at) ?? normSqliteTs(folded.row.updated_at) ?? cols.updated_at;

        // metadata: taskJsonToDbColumns already restored the full metadata blob
        // (via metadata_blob) when task.json was written by dbRowToTaskJson. Apply
        // fold-derived null-authoritative values via applyFoldOverlay — authoritative
        // INCLUDING NULL (R5: reviewer_agent + section both covered):
        //   reviewer_agent: fold cleared it on reopen/release/reassign → json_remove parity
        //   section: three-state per R6 F1 — derive from taskJson key PRESENCE, not fold
        //     (fold collapses absent→null at fold-engine.js:373; that would incorrectly
        //      clear a blob section that taskJsonToDbColumns already left untouched).
        //     'section' in taskJson → key present: pass value or null (authoritative clear)
        //     'section' NOT in taskJson → pass undefined (leave blob untouched, old compat)
        // ROOT D: do NOT discard cols.metadata and rebuild from scratch — that would
        // lose DB-resident sub-fields (source, phase_number, review_feedback, etc.)
        // that are set by SQL json_set() calls and are not independently derivable.
        // F4: clear delete_requested_* when the event trail ends with task_delete_denied
        //   (denyTaskDelete clears these in live DB; stale blob must not resurrect them).
        //   Scan events: find last task_delete_denied and last task_delete_requested.
        //   If last denial is AFTER (or there's no request), clear both fields.
        //   If a request is still pending (requested after last denial, or never denied),
        //   PRESERVE (undefined → leave blob untouched).
        const sectionOverride = 'section' in taskJson ? taskJson.section : undefined;
        let deleteReqOverride = {}; // undefined = leave blob; null = authoritative clear
        {
          let lastDeniedIdx  = -1;
          let lastRequestIdx = -1;
          for (let ei = 0; ei < events.length; ei++) {
            const evt = events[ei];
            if (evt.event_type === 'task_delete_denied')    lastDeniedIdx  = ei;
            if (evt.event_type === 'task_delete_requested') lastRequestIdx = ei;
          }
          if (lastDeniedIdx >= 0 && lastDeniedIdx > lastRequestIdx) {
            // Last denial is the most-recent action → authoritative clear
            deleteReqOverride = { delete_requested_at: null, delete_requested_by: null };
          }
          // Otherwise: request still pending (or no delete activity) → leave blob (undefined/omit)
        }
        cols.metadata = applyFoldOverlay(cols.metadata, {
          reviewer_agent:       folded.row.reviewer_agent ?? null,
          section:              sectionOverride,
          ...deleteReqOverride,
        });

        // ---- 4c-i. Upsert task row (throws on FK failure → txn rolls back) --
        stmts.upsertTaskFromFs.run(
          cols.id,
          cols.project_id,
          cols.phase_id,
          cols.title,
          cols.description,
          cols.status,
          cols.priority,
          cols.assigned_to,
          cols.created_by,
          cols.tags,
          cols.metadata,
          cols.result,
          cols.rejection_count,
          cols.parent_task_id,
          cols.lease_token,
          cols.lease_expires_at,
          cols.created_at,
          cols.updated_at,
          cols.claimed_at,
          cols.submitted_at,
          cols.approved_at,
          cols.deadline,
          taskDir,                    // folder_path
          taskJson.fs_version ?? 0,   // fs_version from file
        );
        tasksAdded++;

        // ---- 4c-ii. Synthesize audit_log rows --------------------------------
        // CLUSTER A (F1): payload = JSON.stringify(ev.data) — matches live shape
        //   insertAudit(..., JSON.stringify({ title, ...data })) without injecting
        //   from_status / to_status (those are top-level event fields, not payload).
        // CLUSTER A (F2): created_at = normTsForAudit → SQLite space-form.
        // CLUSTER C (F12): DELETE before INSERT for idempotence — a second
        //   bootRebuild deletes and re-inserts, keeping audit count constant.
        //   (INSERT OR IGNORE on random PKs would NOT dedup across runs.)
        db.prepare('DELETE FROM audit_log WHERE task_id = ?').run(taskJson.id);
        for (const ev of events) {
          const sqliteAt = normTsForAudit(ev.ts);
          const auditRow = auditRowFromEvent(ev, sqliteAt);
          db.prepare(
            `INSERT INTO audit_log (id, task_id, project_id, actor, event_type, payload, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            auditRow.id,
            auditRow.task_id ?? taskJson.id,
            auditRow.project_id ?? projectId,
            auditRow.actor,
            auditRow.event_type,
            auditRow.payload,
            auditRow.created_at ?? sqliteAt,
          );
          auditAdded++;
        }
      }
    })();
  } catch (err) {
    // Upsert failure → transaction rolled back → task plane stays empty.
    hardErrors.push({ code: 'rebuild_transaction_failed', detail: { error: err.message } });
    return { projects_added: 0, phases_added: 0, tasks_added: 0, audit_added: 0, hard_errors: hardErrors, warnings };
  }

  return {
    projects_added: projectsAdded,
    phases_added: phasesAdded,
    tasks_added: tasksAdded,
    audit_added: auditAdded,
    hard_errors: hardErrors,
    warnings,
  };
}

// -- public API ---------------------------------------------------------------

/**
 * Scan all projects (or a filtered subset) and reconcile fs→DB.
 *
 * CLUSTER D (F9): When CORTEX_BOOT_REBUILD=1 AND the task plane is empty,
 * scanAll runs the full-rebuild path FIRST (synchronously, before the
 * normal reconcile loop) so the boot hook in composer.js only needs to call
 * scanAll — the flag+empty detection lives here, not exclusively in composer.
 * This preserves the pre-listen synchronous behavior under the flag and keeps
 * the boot hook + the operational reconcile route using the same codepath.
 *
 * @param {object} opts
 * @param {boolean} [opts.dryRun=false]
 * @param {string|null} [opts.projectFilter=null] — project slug or id
 * @param {string|null} [opts.projectsRoot=null] — override for boot-rebuild path
 * @returns {Promise<object>} diff shape per LEDGER-SCHEMA.md §4.3 (user variant)
 */
export async function scanAll({ dryRun = false, projectFilter = null, projectsRoot = null } = {}) {
  // ROOT A (F1/F5): When CORTEX_BOOT_REBUILD=1 AND the task plane is empty,
  // bootRebuild is THE AUTHORITATIVE path. If it reports hard_errors, scanAll
  // ABORTS immediately — it must NEVER fall through to the legacy reconcileProject
  // loop. That legacy path (reconcileProject → upsertTaskFromFs) inserts task rows
  // from task.json WITHOUT folding events.jsonl, violating the single-fold-codepath
  // guarantee and allowing a corrupt events.jsonl to still populate the task plane
  // via the non-fold path.
  //
  // Abort means: return a report shape that signals the rebuild failed and that
  // ZERO reconcile-project work was done. The task plane stays empty — retrigerable
  // by the next flagged boot.
  if (process.env.CORTEX_BOOT_REBUILD === '1' && isTaskPlaneEmpty()) {
    const { resolveProjectsRoot } = await import('@cortex/core/constants');
    const root = projectsRoot ?? resolveProjectsRoot();
    if (root) {
      if (dryRun) {
        // ROOT 1 (R7): dryRun inside the flag+empty branch — run the SAME
        // planning+fold passes bootRebuild does, but ZERO DB writes.
        // Returns the same abort/would-rebuild shape bootRebuild would produce.
        // NEVER falls through to the legacy reconcileProject loop — that path
        // inserts task rows WITHOUT folding events.jsonl, violating the single-
        // fold-codepath guarantee.
        const plan = _planBootRebuild(root);
        if (plan.hardErrors.length > 0) {
          console.error('[scanAll] boot-rebuild dry-run ABORTED — hard errors:',
            JSON.stringify(plan.hardErrors));
          return {
            scanned_at: new Date().toISOString(),
            dry_run: true,
            aborted: true,
            abort_reason: 'boot_rebuild_hard_errors',
            hard_errors: plan.hardErrors,
            warnings: plan.warnings,
            projects: [],
            totals: {
              added: 0, updated: 0, removed: 0,
              projects_scanned: 0, parity_failures: 0,
            },
          };
        }
        // No hard errors — return a would-rebuild report (no DB writes)
        return {
          scanned_at: new Date().toISOString(),
          dry_run: true,
          boot_rebuild: true,
          would_rebuild: true,
          projects: [],
          totals: {
            added: plan.workPlan.length,
            updated: 0,
            removed: 0,
            projects_scanned: plan.projectPlan.length,
            parity_failures: 0,
          },
        };
      }

      const rebuildReport = await bootRebuild(root);
      if (rebuildReport.hard_errors.length > 0) {
        // ABORT: loud report, no legacy reconcile fallback.
        // The fold engine is the SINGLE fold codepath; hard errors here mean
        // the task plane intentionally stays empty until a clean retry.
        console.error('[scanAll] boot-rebuild ABORTED — hard errors prevent reconcile fallback:',
          JSON.stringify(rebuildReport.hard_errors));
        return {
          scanned_at: new Date().toISOString(),
          dry_run: dryRun,
          aborted: true,
          abort_reason: 'boot_rebuild_hard_errors',
          hard_errors: rebuildReport.hard_errors,
          warnings: rebuildReport.warnings ?? [],
          projects: [],
          totals: {
            added: 0, updated: 0, removed: 0,
            projects_scanned: 0, parity_failures: 0,
          },
        };
      }
      console.log(
        `[scanAll] boot-rebuild: tasks_added=${rebuildReport.tasks_added}` +
        ` audit_added=${rebuildReport.audit_added}`,
      );
      // Rebuild succeeded — task plane is populated. Return a summary without
      // running the legacy reconcileProject loop (rebuild IS the reconcile).
      return {
        scanned_at: new Date().toISOString(),
        dry_run: dryRun,
        boot_rebuild: true,
        projects: [],
        totals: {
          added: rebuildReport.tasks_added,
          updated: 0,
          removed: 0,
          projects_scanned: rebuildReport.projects_added,
          parity_failures: 0,
        },
      };
    }
  }

  const stmts = getTaskStatements();
  const allProjects = stmts.listProjects.all();

  const projects = projectFilter
    ? allProjects.filter((p) =>
        p.id === projectFilter ||
        (p.slug || p.name) === projectFilter ||
        p.name === projectFilter,
      )
    : allProjects;

  const results = [];
  let totalAdded = 0;
  let totalUpdated = 0;
  let totalRemoved = 0;
  let parityFailures = 0;

  for (const project of projects) {
    const result = await reconcileProject(project, { dryRun });
    results.push(result);
    totalAdded += result.added;
    totalUpdated += result.updated;
    totalRemoved += result.removed;
    if (!result.parity_ok) parityFailures++;
  }

  return {
    scanned_at: new Date().toISOString(),
    dry_run: dryRun,
    projects: results,
    totals: {
      added: totalAdded,
      updated: totalUpdated,
      removed: totalRemoved,
      projects_scanned: results.length,
      parity_failures: parityFailures,
    },
  };
}

/**
 * Reconcile a single project by its ID or slug.
 *
 * @param {string} projectId — project UUID or slug
 * @param {object} opts
 * @param {boolean} [opts.dryRun=false]
 * @returns {Promise<object>} per-project diff (same shape as projects[] entry in scanAll)
 */
export async function reconcileProjectById(projectId, { dryRun = false } = {}) {
  const stmts = getTaskStatements();
  const project =
    stmts.getProject.get(projectId) ||
    stmts.listProjects.all().find((p) => p.name === projectId || p.slug === projectId);

  if (!project) {
    return {
      project_id: projectId,
      slug: projectId,
      added: 0,
      updated: 0,
      removed: 0,
      parity_ok: true,
      tasks: [],
      error: 'project_not_found',
    };
  }

  return reconcileProject(project, { dryRun });
}
