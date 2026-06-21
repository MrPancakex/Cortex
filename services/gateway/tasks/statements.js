/**
 * Prepared-statement map for the tasks plane. Covers:
 *   - tasks (create/read/list + every state transition)
 *   - progress_reports (insert/query — still used for UI chronology and
 *     stub tracking; the journal is the new authoritative completeness
 *     signal but progress_reports remains the quick-read "timeline" table)
 *   - task_comments (approval/rejection/note rows)
 *   - task_journal (Phase 5 — structured, type-enforced appends)
 *
 * Lazy-constructed on first access with the auto-invalidate pattern from
 * bridge/statements.js: if a test rotates the underlying DB handle via
 * resetDbForTests() + a fresh getDb({path:...}), the cache detects the
 * handle swap and rebuilds rather than silently issuing statements bound
 * to a stale (possibly unlinked) file.
 */

import { getDb, createStatements } from '@cortex/sdk/db';

const SPECS = [
  // -- tasks (read) --------------------------------------------------------
  { name: 'getTask',
    sql: 'SELECT * FROM tasks WHERE id = ?' },
  { name: 'listTasks',
    sql: `SELECT * FROM tasks
          ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
          LIMIT ?` },
  { name: 'listTasksByStatus',
    sql: `SELECT * FROM tasks WHERE status = ?
          ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
          LIMIT ?` },
  // Positional params are intentional — bun:sqlite's parameter adapter
  // treats `?N` placeholders the same way node-better-sqlite3 does.
  // `LOWER(COALESCE(..., ''))` survives NULL assigned_to rows.
  { name: 'listTasksFiltered',
    sql: `SELECT * FROM tasks
          WHERE (?1 IS NULL OR status = ?1)
            AND (?2 IS NULL OR LOWER(COALESCE(assigned_to, '')) = LOWER(?2))
            AND (?3 IS NULL OR project_id = ?3)
            AND (?4 IS NULL OR metadata LIKE '%"source":"' || ?4 || '"%')
          ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC
          LIMIT ?5` },
  { name: 'listTasksByProject',
    sql: `SELECT * FROM tasks WHERE project_id = ?
          ORDER BY datetime(updated_at) DESC, datetime(created_at) DESC` },

  // -- tasks (write) -------------------------------------------------------
  //
  // Every write sets updated_at = datetime('now') so the list path's ORDER
  // BY surfaces the most-recently-touched row first.
  { name: 'createTask',
    sql: `INSERT INTO tasks
            (id, project_id, phase_id, title, description, status, priority,
             assigned_to, created_by, tags, metadata, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?,
                  datetime('now'), datetime('now'))` },

  // Race-safe: WHERE status='pending' makes the UPDATE idempotent — two
  // agents racing to claim the same task will see one .changes === 1 and
  // one .changes === 0. The `changes === 0` branch is the 409 path.
  { name: 'claimTask',
    sql: `UPDATE tasks
          SET status = 'claimed',
              assigned_to = ?,
              claimed_at = datetime('now'),
              updated_at = datetime('now')
          WHERE id = ? AND status = 'pending'` },

  // claimOrphanedTask — short-circuits 'orphaned' → 'in_progress' because
  // the claimer is inheriting work, not starting fresh. See Phase 5 spec
  // §5.5 — this is the 'continuity of thinking' path.
  { name: 'claimOrphanedTask',
    sql: `UPDATE tasks
          SET status = 'in_progress',
              assigned_to = ?,
              claimed_at = datetime('now'),
              updated_at = datetime('now')
          WHERE id = ? AND status = 'orphaned'` },

  // orphanTask — flipped by the session reaper. Clears ownership so a
  // subsequent claimOrphan produces a clean row. Only applies to
  // ACTIVE statuses (claimed / in_progress / submitted / review) —
  // terminal rows (approved / cancelled / failed) must NOT be orphaned.
  { name: 'orphanTask',
    sql: `UPDATE tasks
          SET status = 'orphaned',
              assigned_to = NULL,
              updated_at = datetime('now')
          WHERE id = ? AND status IN ('claimed','in_progress','submitted','review')` },

  // stampOrphanMetadata — follows orphanTask inside the same transaction to
  // persist the previous_owner + reason into tasks.metadata so claimOrphan
  // can recover them later. Uses json_set so other metadata keys survive.
  { name: 'stampOrphanMetadata',
    sql: `UPDATE tasks
          SET metadata = json_set(
            json_set(COALESCE(metadata, '{}'),
              '$.previous_owner', ?),
            '$.orphan_reason', ?)
          WHERE id = ?` },

  { name: 'resumeFromClaim',
    sql: `UPDATE tasks SET status = 'in_progress', updated_at = datetime('now')
          WHERE id = ? AND status = 'claimed'` },
  { name: 'resumeFromReject',
    sql: `UPDATE tasks SET status = 'in_progress', updated_at = datetime('now')
          WHERE id = ? AND status = 'rejected'` },

  { name: 'submitTask',
    sql: `UPDATE tasks
          SET status = 'submitted',
              result = ?,
              submitted_at = datetime('now'),
              updated_at = datetime('now')
          WHERE id = ? AND status = 'in_progress'` },

  { name: 'verifyTask',
    sql: `UPDATE tasks
          SET status = 'review',
              metadata = json_set(COALESCE(metadata,'{}'), '$.reviewer_agent', ?),
              updated_at = datetime('now')
          WHERE id = ? AND status = 'submitted'` },

  { name: 'approveTask',
    sql: `UPDATE tasks
          SET status = 'approved',
              approved_at = datetime('now'),
              metadata = json_set(COALESCE(metadata,'{}'), '$.review_feedback', ?),
              updated_at = datetime('now')
          WHERE id = ? AND status = 'review'` },

  { name: 'rejectTask',
    sql: `UPDATE tasks
          SET status = 'rejected',
              metadata = json_set(COALESCE(metadata,'{}'), '$.review_feedback', ?),
              updated_at = datetime('now')
          WHERE id = ? AND status = 'review'` },

  { name: 'incrementRejectionCount',
    sql: `UPDATE tasks SET rejection_count = COALESCE(rejection_count, 0) + 1
          WHERE id = ?` },

  // reopen: terminal (approved/rejected) → pending with a clean owner slot.
  { name: 'reopenTask',
    sql: `UPDATE tasks
          SET status = 'pending',
              assigned_to = NULL,
              claimed_at = NULL,
              metadata = json_remove(COALESCE(metadata,'{}'), '$.reviewer_agent'),
              updated_at = datetime('now')
          WHERE id = ? AND status IN ('approved','rejected')` },

  { name: 'cancelTask',
    sql: `UPDATE tasks
          SET status = 'cancelled',
              assigned_to = NULL,
              metadata = json_set(
                json_set(COALESCE(metadata,'{}'),
                  '$.cancelled_by', ?),
                '$.cancel_reason', ?),
              updated_at = datetime('now')
          WHERE id = ? AND status NOT IN ('cancelled','approved','failed')` },

  // fail: any non-terminal task → failed (frontend "fail" button). `failed`
  // is already in TaskStatusSchema; the cutover just never mounted a route.
  { name: 'failTask',
    sql: `UPDATE tasks
          SET status = 'failed',
              metadata = json_set(
                json_set(COALESCE(metadata,'{}'),
                  '$.failed_by', ?),
                '$.fail_reason', ?),
              updated_at = datetime('now')
          WHERE id = ? AND status NOT IN ('cancelled','approved','failed')` },

  // Delete-request approval workflow (the frontend has the UI; the
  // cutover never backed it). Side-data lives in metadata JSON like
  // every other lifecycle annotation — no schema migration.
  { name: 'requestTaskDelete',
    sql: `UPDATE tasks
          SET metadata = json_set(
                json_set(COALESCE(metadata,'{}'),
                  '$.delete_requested_at', ?),
                '$.delete_requested_by', ?),
              updated_at = datetime('now')
          WHERE id = ?
            AND json_extract(COALESCE(metadata,'{}'), '$.delete_requested_at') IS NULL` },

  { name: 'denyTaskDelete',
    sql: `UPDATE tasks
          SET metadata = json_remove(
                json_remove(COALESCE(metadata,'{}'),
                  '$.delete_requested_at'),
                '$.delete_requested_by'),
              updated_at = datetime('now')
          WHERE id = ?
            AND json_extract(COALESCE(metadata,'{}'), '$.delete_requested_at') IS NOT NULL` },

  // approve-delete is a hard row removal — the folder is renamed to a
  // `(deleted)` suffix by the handler (lifecycle convention: rename,
  // never rm -rf) so the on-disk work record stays recoverable.
  { name: 'hardDeleteTask',
    sql: `DELETE FROM tasks
          WHERE id = ?
            AND json_extract(COALESCE(metadata,'{}'), '$.delete_requested_at') IS NOT NULL` },

  { name: 'listDeleteRequests',
    sql: `SELECT * FROM tasks
          WHERE json_extract(COALESCE(metadata,'{}'), '$.delete_requested_at') IS NOT NULL
          ORDER BY updated_at DESC` },

  // Reassign: returns to pending under a new owner. Admin-only — the
  // handler enforces that.
  { name: 'reassignTask',
    sql: `UPDATE tasks
          SET status = 'pending',
              assigned_to = ?,
              claimed_at = NULL,
              metadata = json_remove(COALESCE(metadata,'{}'), '$.reviewer_agent'),
              updated_at = datetime('now')
          WHERE id = ? AND status NOT IN ('approved','rejected','cancelled','failed')` },

  { name: 'releaseTask',
    sql: `UPDATE tasks
          SET status = 'pending',
              assigned_to = NULL,
              claimed_at = NULL,
              metadata = json_remove(COALESCE(metadata,'{}'), '$.reviewer_agent'),
              updated_at = datetime('now')
          WHERE id = ? AND status IN ('claimed','in_progress','review')` },

  // COALESCE(?N, column) — nullable args mean "skip this field". Callers
  // pass explicit nulls for untouched columns. metadata is the JSON blob
  // updateTask() rewrites when the caller changes `section`; passing
  // null for ?5 means "keep existing metadata" so the dashboard's
  // section grouping is preserved across non-section updates.
  { name: 'updateTask',
    sql: `UPDATE tasks
          SET title = COALESCE(?1, title),
              description = COALESCE(?2, description),
              priority = COALESCE(?3, priority),
              tags = COALESCE(?4, tags),
              metadata = COALESCE(?5, metadata),
              updated_at = datetime('now')
          WHERE id = ?6` },

  // bumpFsVersion — Plane-transition Phase 1b (spec §4). The authoritative
  // dual-writer (dualWrite/dualWriteNoGuard) runs this inside the SAME
  // transaction as the state mutation so every state-changing FS write
  // monotonically increments tasks.fs_version by exactly 1. The bumped value
  // then flows into the written task.json via syncFiles → dbRowToTaskJson,
  // keeping DB and FS consistent. This is the hard precondition of the
  // version-gated FS-wins reconcile: FS wins iff task.json.fs_version >=
  // tasks.fs_version (reconciler.js:6,253-262). Unconditional (no status
  // guard) — it always follows a mutate whose own guard already fired.
  { name: 'bumpFsVersion',
    sql: `UPDATE tasks SET fs_version = fs_version + 1 WHERE id = ?` },

  // -- progress_reports ----------------------------------------------------
  //
  // Mirrors the legacy surface. Stage = status for the UI chronology pane;
  // metadata is a JSON blob that carries files_changed/stub flags. Stub
  // detection lives in Phase 7's gate plane; Phase 5 just counts flagged
  // rows via countStubsByTask.
  { name: 'insertProgress',
    sql: `INSERT INTO progress_reports
            (id, task_id, agent_id, stage, percent, message, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?)` },
  { name: 'progressByTaskAsc',
    sql: `SELECT * FROM progress_reports WHERE task_id = ?
          ORDER BY datetime(created_at) ASC` },
  { name: 'progressByTaskDesc',
    sql: `SELECT * FROM progress_reports WHERE task_id = ?
          ORDER BY datetime(created_at) DESC` },
  { name: 'countProgressByTask',
    sql: `SELECT COUNT(*) AS count FROM progress_reports WHERE task_id = ?` },
  { name: 'countStubsByTask',
    sql: `SELECT COUNT(*) AS count FROM progress_reports
          WHERE task_id = ? AND metadata LIKE '%"stub_detected":true%'` },
  // "progress with files" is a soft precondition for submit — the handler
  // wants at least one row whose files_changed array is non-empty.
  { name: 'countProgressWithFiles',
    sql: `SELECT COUNT(*) AS count FROM progress_reports
          WHERE task_id = ?
            AND metadata LIKE '%"files_changed":[%'
            AND metadata NOT LIKE '%"files_changed":[]%'` },

  // -- task_comments -------------------------------------------------------
  { name: 'insertTaskComment',
    sql: `INSERT INTO task_comments (id, task_id, author, body)
          VALUES (?, ?, ?, ?)` },
  { name: 'getTaskComments',
    sql: `SELECT * FROM task_comments WHERE task_id = ?
          ORDER BY datetime(created_at) ASC` },

  // -- task_journal (Phase 5) ---------------------------------------------
  { name: 'insertTaskJournal',
    sql: `INSERT INTO task_journal
            (id, task_id, entry_type, summary, files_changed, metadata, author)
          VALUES (?, ?, ?, ?, ?, ?, ?)` },
  { name: 'journalByTaskAsc',
    sql: `SELECT * FROM task_journal WHERE task_id = ?
          ORDER BY created_at ASC` },
  { name: 'journalByTaskFilteredAsc',
    sql: `SELECT * FROM task_journal WHERE task_id = ? AND entry_type = ?
          ORDER BY created_at ASC LIMIT ?` },
  { name: 'countJournalByType',
    sql: `SELECT entry_type, COUNT(*) AS count FROM task_journal
          WHERE task_id = ? GROUP BY entry_type` },

  // -- projects ------------------------------------------------------------
  { name: 'getProject',
    sql: 'SELECT * FROM projects WHERE id = ?' },
  { name: 'listProjects',
    sql: `SELECT * FROM projects ORDER BY datetime(created_at) DESC` },
  { name: 'createProject',
    sql: `INSERT INTO projects (id, name, description, root_path, metadata)
          VALUES (?, ?, ?, ?, ?)` },
  { name: 'updateProjectMetadata',
    sql: `UPDATE projects SET metadata = ?, updated_at = datetime('now')
          WHERE id = ?` },
  // Slice A follow-up (2026-05-25): allow PATCH to repoint root_path so
  // misplaced projects (e.g. cortex-v03 stuck at /tmp/) can be moved
  // without a direct SQL UPDATE.
  { name: 'updateProjectRootPath',
    sql: `UPDATE projects SET root_path = ?, updated_at = datetime('now')
          WHERE id = ?` },
  // B2c: persist name and description via PATCH /v1/api/projects/:id.
  { name: 'updateProjectNameDesc',
    sql: `UPDATE projects SET name = ?, description = ?, updated_at = datetime('now')
          WHERE id = ?` },

  // Project delete-request workflow (V2-gap B5). Mirrors the task
  // delete-request statements above — metadata-flag based, no
  // migration. Approve cascades to child tasks (see hardDeleteTasksByProject).
  { name: 'requestProjectDelete',
    sql: `UPDATE projects
          SET metadata = json_set(
                json_set(COALESCE(metadata,'{}'),
                  '$.delete_requested_at', ?),
                '$.delete_requested_by', ?),
              updated_at = datetime('now')
          WHERE id = ?
            AND json_extract(COALESCE(metadata,'{}'), '$.delete_requested_at') IS NULL` },

  { name: 'denyProjectDelete',
    sql: `UPDATE projects
          SET metadata = json_remove(
                json_remove(COALESCE(metadata,'{}'),
                  '$.delete_requested_at'),
                '$.delete_requested_by'),
              updated_at = datetime('now')
          WHERE id = ?
            AND json_extract(COALESCE(metadata,'{}'), '$.delete_requested_at') IS NOT NULL` },

  { name: 'hardDeleteProject',
    sql: `DELETE FROM projects
          WHERE id = ?
            AND json_extract(COALESCE(metadata,'{}'), '$.delete_requested_at') IS NOT NULL` },

  // Cascade: on approved project delete, every child task row is removed.
  // Project delete is DB-only (no folder rename) — the on-disk project tree
  // is left untouched; this purely clears the rows. No per-task delete flag
  // needed — the project approval IS the approval.
  { name: 'hardDeleteTasksByProject',
    sql: `DELETE FROM tasks WHERE project_id = ?` },

  { name: 'listProjectDeleteRequests',
    sql: `SELECT * FROM projects
          WHERE json_extract(COALESCE(metadata,'{}'), '$.delete_requested_at') IS NOT NULL
          ORDER BY updated_at DESC` },

  // -- phases --------------------------------------------------------------
  { name: 'listPhases',
    sql: `SELECT * FROM phases WHERE project_id = ? ORDER BY ordinal ASC` },
  { name: 'createPhase',
    sql: `INSERT INTO phases (id, project_id, name, ordinal, status)
          VALUES (?, ?, ?, ?, 'pending')` },
  { name: 'countPhases',
    sql: `SELECT COUNT(*) AS count FROM phases WHERE project_id = ?` },
  // Delete a phase by its project + 0-based ordinal (V2-gap B7). Child
  // tasks survive — tasks.phase_id is ON DELETE SET NULL, so the FK
  // un-buckets them automatically.
  { name: 'deletePhaseByOrdinal',
    sql: `DELETE FROM phases WHERE project_id = ? AND ordinal = ?` },
  // After a mid-sequence delete, close the ordinal gap so phases stay
  // contiguous (0-based). addPhase derives the next ordinal from a row
  // COUNT, and phaseIdForProject maps 1-based phase_number → ordinal;
  // both break if gaps are left behind. Run in the same tx as the delete.
  { name: 'compactPhaseOrdinals',
    sql: `UPDATE phases SET ordinal = ordinal - 1
          WHERE project_id = ? AND ordinal > ?` },

  // -- orphan-reaper helper (consumed by Phase 6) --------------------------
  { name: 'listTasksByOwner',
    sql: `SELECT id, status FROM tasks
          WHERE assigned_to = ?
            AND status IN ('claimed','in_progress','submitted','review')` },

  // -- agent existence probe (FK pre-check for reassign) -------------------
  { name: 'getAgentById',
    sql: 'SELECT id FROM agents WHERE id = ?' },

  // -- audit_log (Slice A Phase 4 — C3 dual-write contract) ----------------
  //
  // insertAudit: called inside dualWrite() (ledger.js) within the same
  // SQLite transaction that mutates the task row and appends to ledger.jsonl.
  // Positional params: id, task_id, project_id, actor, event_type, payload.
  // created_at is left to the column DEFAULT (datetime('now')).
  { name: 'insertAudit',
    sql: `INSERT INTO audit_log
            (id, task_id, project_id, actor, event_type, payload)
          VALUES (?, ?, ?, ?, ?, ?)` },

  // listAudit: used by the Phase 5 reconciler parity check — returns all
  // rows for a project in ascending chronological order so the reconciler
  // can walk them in the same order as ledger.jsonl lines.
  { name: 'listAudit',
    sql: `SELECT * FROM audit_log WHERE project_id = ?
          ORDER BY created_at ASC` },

  // countAuditForProject: fast scalar for the ledger parity invariant
  // (LEDGER-SCHEMA.md §2.7): after N transitions on project P,
  // wc -l ledger.jsonl === SELECT COUNT(*) FROM audit_log WHERE project_id = ?
  { name: 'countAuditForProject',
    sql: `SELECT COUNT(*) AS n FROM audit_log WHERE project_id = ?` },

  // listAuditForTask: used by getAudit() handler (queries.js) — returns all
  // audit_log rows for a single task in strict chronological order.
  // created_at is second-granularity (datetime('now')) and `id` is a random
  // UUID, so a secondary sort by id would SHUFFLE same-second rows rather than
  // order them. The implicit rowid is monotonic with INSERT order (audit_log
  // is a normal rowid table — migration 012, no WITHOUT ROWID), so it breaks
  // same-second ties in true insertion order.
  { name: 'listAuditForTask',
    sql: `SELECT * FROM audit_log WHERE task_id = ? ORDER BY created_at ASC, rowid ASC` },

  // -- reconciler (Slice A Phase 5) ----------------------------------------
  //
  // getPhaseByOrdinal: resolves phase_id for a project+ordinal pair during
  // reconciler fs→DB traversal. ordinal is 0-based (phases.ordinal column);
  // phase_number from task folders is 1-based, so callers pass (number - 1).
  { name: 'getPhaseByOrdinal',
    sql: `SELECT * FROM phases WHERE project_id = ? AND ordinal = ? LIMIT 1` },

  // listTasksByProject (all): returns every task row for a project so the
  // reconciler can find DB-only rows (orphans) that have no task.json on disk.
  // Already covered by listTasksByProject above (same SQL).
  // upsertTaskFromFs: INSERT OR REPLACE a task row from a task.json object.
  // Called by the reconciler's "added" path (new fs task not in DB).
  // All domain columns are provided; fs_version and folder_path are set
  // explicitly by the reconciler (not from task.json directly).
  { name: 'upsertTaskFromFs',
    sql: `INSERT INTO tasks
            (id, project_id, phase_id, title, description, status, priority,
             assigned_to, created_by, tags, metadata, result,
             rejection_count, parent_task_id, lease_token, lease_expires_at,
             created_at, updated_at, claimed_at, submitted_at, approved_at, deadline,
             folder_path, fs_version)
          VALUES
            (?1, ?2, ?3, ?4, ?5, ?6, ?7,
             ?8, ?9, ?10, ?11, ?12,
             ?13, ?14, ?15, ?16,
             ?17, ?18, ?19, ?20, ?21, ?22,
             ?23, ?24)
          ON CONFLICT(id) DO UPDATE SET
            project_id = excluded.project_id,
            phase_id = excluded.phase_id,
            title = excluded.title,
            description = excluded.description,
            status = excluded.status,
            priority = excluded.priority,
            assigned_to = excluded.assigned_to,
            created_by = excluded.created_by,
            tags = excluded.tags,
            metadata = excluded.metadata,
            result = excluded.result,
            rejection_count = excluded.rejection_count,
            parent_task_id = excluded.parent_task_id,
            lease_token = excluded.lease_token,
            lease_expires_at = excluded.lease_expires_at,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            claimed_at = excluded.claimed_at,
            submitted_at = excluded.submitted_at,
            approved_at = excluded.approved_at,
            deadline = excluded.deadline,
            folder_path = excluded.folder_path,
            fs_version = excluded.fs_version` },

  // updateTaskFromFs: UPDATE a task row from fs for the "updated" reconciler
  // path. Does NOT change updated_at — preserves the on-disk timestamp.
  // Sets fs_version to the file's fs_version (?22) so DB and task.json stay
  // aligned after an FS-win repair. (Blind increment was removed in Phase 4
  // R5: incrementing left DB ahead of the file, corrupting the version gate
  // used for future FS-win vs DB-ahead decisions.)
  // Caller binds: phase_id, title, description, status, priority, assigned_to,
  // created_by, tags, metadata, result, rejection_count, parent_task_id,
  // lease_token, lease_expires_at, created_at, updated_at, claimed_at,
  // submitted_at, approved_at, deadline, folder_path, fs_version, id.
  { name: 'updateTaskFromFs',
    sql: `UPDATE tasks SET
            phase_id = ?1,
            title = ?2,
            description = ?3,
            status = ?4,
            priority = ?5,
            assigned_to = ?6,
            created_by = ?7,
            tags = ?8,
            metadata = ?9,
            result = ?10,
            rejection_count = ?11,
            parent_task_id = ?12,
            lease_token = ?13,
            lease_expires_at = ?14,
            created_at = ?15,
            updated_at = ?16,
            claimed_at = ?17,
            submitted_at = ?18,
            approved_at = ?19,
            deadline = ?20,
            folder_path = ?21,
            fs_version = ?22
          WHERE id = ?23` },

  // -- runs (Slice B Phase 1, 2026-05-25): runs table — derived DB index of runs.jsonl.
  // Written by services/gateway/subagents/spawn.js when a bounded sub-agent
  // starts and updated on its exit.
  { name: 'insertRun',
    sql: `INSERT INTO runs
          (run_id, task_id, provider_id, model, status, started_at,
           budget_max_tokens, budget_max_wall_seconds, budget_max_tool_calls)
          VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?, ?)` },
  { name: 'updateRunOnExit',
    sql: `UPDATE runs SET status = ?, ended_at = datetime('now'),
          tokens_in = ?, tokens_out = ?, cost_usd = ?, exit_reason = ?
          WHERE run_id = ?` },
  { name: 'getRun',
    sql: `SELECT * FROM runs WHERE run_id = ?` },
  { name: 'listRunsByTask',
    sql: `SELECT * FROM runs WHERE task_id = ? ORDER BY started_at DESC` },
  { name: 'countRunsByTask',
    sql: `SELECT COUNT(*) AS n FROM runs WHERE task_id = ?` },

  // listAllRuns: returns recent runs across all tasks (no task_id filter).
  // Used by GET /v1/api/subagents when no task_id query param is provided.
  // LIMIT 200 caps memory pressure on large deployments.
  { name: 'listAllRuns',
    sql: `SELECT * FROM runs ORDER BY started_at DESC LIMIT 200` },

  // -- subagent_events dashboard projection -------------------------------
  //
  // GET /v1/api/subagents exposes this alongside the bounded `runs` rows.
  // `subagent_events` is the Plane-1 dashboard waterfall source for manually
  // registered workers (for example reviewer sub-agents).
  { name: 'listSubagentEvents',
    sql: `SELECT id, parent_agent, subagent_id, subagent_type, description,
                 task_id, status, started_at, completed_at, duration_ms,
                 tool_calls, result_summary, input_tokens, cached_input_tokens,
                 output_tokens, cost_usd, model, provider, runtime
          FROM subagent_events
          ORDER BY started_at DESC
          LIMIT 200` },

  // Slice C cleanup (2026-05-25): populate proxy_subagent_id FK from
  // subagents/spawn.js after proxyFn returns the subagent row id.
  // Param order: (proxy_subagent_id, run_id).
  { name: 'updateRunProxySubagentId',
    sql: `UPDATE runs SET proxy_subagent_id = ? WHERE run_id = ?` },

  // Lookup of the proxy subagent process by its id. Used by /close to find
  // the subagent row for SIGTERM via closeSubagent(). This is the task-plane
  // mirror of proxy/statements.js:getSubagent — needed here because
  // routes.js imports from tasks/statements.js, not proxy/statements.js.
  { name: 'getSubagentById',
    sql: `SELECT id, pid, state FROM subagents WHERE id = ?` },

  // -- Slice F.1 (2026-05-25): artifact_path on runs ----------------------
  //
  // updateRunArtifactPath: set artifact_path for a completed tool run
  // (Blender, render-tool, and similar production tools). Called by F.2-F.6 adapters
  // after the tool finishes producing output files. The value is either a
  // single absolute path (TEXT) or a JSON array of paths — consumer parses.
  // Never called by LLM-run paths; those leave artifact_path NULL.
  // Params: (artifact_path TEXT, run_id TEXT).
  { name: 'updateRunArtifactPath',
    sql: `UPDATE runs SET artifact_path = ? WHERE run_id = ?` },

  // -- Slice B Phase 2 (2026-05-25): lease activation ---------------------
  //
  // The lease_token + lease_expires_at columns exist since migration 001
  // but were dormant until Slice B; sub-agent spawn writes them as a TTL
  // claim, and the reaper (Phase 3) reads listExpiredLeasedTasks to detect
  // stale runs and orphan them back to the queue.
  { name: 'activateTaskLease',
    sql: `UPDATE tasks SET lease_token = ?, lease_expires_at = ?,
          updated_at = datetime('now') WHERE id = ?` },

  { name: 'releaseTaskLease',
    sql: `UPDATE tasks SET lease_token = NULL, lease_expires_at = NULL,
          updated_at = datetime('now') WHERE id = ? AND lease_token = ?` },

  { name: 'listExpiredLeasedTasks',
    sql: `SELECT id, lease_token, lease_expires_at FROM tasks
          WHERE lease_expires_at IS NOT NULL
          AND datetime(lease_expires_at) < datetime('now')` },

  // -- Slice E (2026-05-25): runs summary aggregate ------------------------
  //
  // runsSummaryWindowed: aggregate cost/token totals per provider across a
  // rolling time window. The `?` param is a SQLite datetime modifier string
  // like '-24 hours'. Used by GET /v1/api/runs/summary?window=24h.
  { name: 'runsSummaryWindowed',
    sql: `SELECT
            provider_id,
            COUNT(*) AS run_count,
            SUM(tokens_in) AS total_tokens_in,
            SUM(tokens_out) AS total_tokens_out,
            SUM(cost_usd) AS total_cost_usd,
            COUNT(CASE WHEN status='completed' THEN 1 END) AS completed,
            COUNT(CASE WHEN status='failed' THEN 1 END) AS failed,
            COUNT(CASE WHEN status='budget_exceeded' THEN 1 END) AS budget_exceeded
          FROM runs
          WHERE datetime(started_at) >= datetime('now', ?)
          GROUP BY provider_id` },

  // -- Slice B Phase 3 (2026-05-25): subagent reaper sweep -----------------
  //
  // Closes the architecture-reference.md-promised 10-min GC for stale running rows
  // that does not exist in v0.2 base code. All timestamps are UNIX-epoch
  // SECONDS (not millis) — matching every existing writer in
  // sdk/sessions/subagent-lifecycle.js (registerTaskWorker et al. all use
  // Math.floor(Date.now() / 1000)). The spec assumed millis; that
  // assumption was incorrect and is fixed here.
  //
  // reapStaleRunningSubagents: mark old status='running' rows as 'failed'.
  // Bound param: cutoff (INTEGER, seconds epoch).
  { name: 'reapStaleRunningSubagents',
    sql: `UPDATE subagent_events
          SET status = 'failed',
              completed_at = strftime('%s', 'now'),
              result_summary = COALESCE(result_summary, 'reaped: status=running > 1h')
          WHERE status = 'running' AND started_at < ?` },

  // countStaleRunningSubagents: count candidates (used for visibility when
  // no rows were reaped). Bound param: cutoff (INTEGER, seconds epoch).
  { name: 'countStaleRunningSubagents',
    sql: `SELECT COUNT(*) AS n FROM subagent_events
          WHERE status = 'running' AND started_at < ?` },
];

let _cached = null;
let _cachedDb = null;

export function getTaskStatements() {
  const db = getDb();
  if (_cached && _cachedDb === db) return _cached;
  _cached = createStatements(db, SPECS);
  _cachedDb = db;
  return _cached;
}

export function resetTaskStatementsForTests() {
  _cached = null;
  _cachedDb = null;
}
