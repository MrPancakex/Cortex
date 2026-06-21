# WRITERS-INVENTORY — every mutation path for task DB state + canonical task-folder files

> Task 120 (D1). This document enumerates EVERY code path that mutates task DB
> state (tasks / task_comments / task_journal / progress_reports / audit_log
> rows) or canonical task-folder files (task.json / events.jsonl / ledger.jsonl
> / folder renames / README.md). Each path is classified:
>
>   - **EMITS-OK** — the path records its transition via the compensated
>     in-transaction dual-write (`dualWrite` / `dualWriteNoGuard` /
>     the extended-transaction `appendLedgerAndEvents` pattern): row mutation +
>     `fs_version` bump + audit_log row + ledger.jsonl line + per-task
>     events.jsonl line all land in ONE SQLite transaction, with byte-length
>     compensation on the FS side (ledger.js `appendLedgerAndEvents`) and
>     folder-creation compensation (`removeCreatedTaskDir`) so a failure leaves
>     zero residue.
>   - **EXEMPT** — the path does not (and must not / need not) emit a
>     transition event; the reason is given inline and is itself reviewable.
>
> Line numbers are anchors as of the commit that introduces this file; the
> companion test `tests/writers-inventory.test.js` checks the *name-based*
> claims mechanically so drift in line numbers cannot silently rot the
> inventory.

## 0. Terms

- **EVENT** (capitalised, per the Task 120 contract) = a line in the durable
  file trail: per-project `ledger.jsonl` + per-task `events.jsonl` (locked 1a
  schema `{ts,task_id,project_id,actor,event_type,from_status,to_status,data}`).
  EVENTs are written ONLY inside the db.transaction compensated path — never
  post-commit, never best-effort.
- The `emitTask*` calls (events.js) are **typed bus notifications** (WS fanout
  / wake), not EVENTs. They are ephemeral, post-commit and best-effort by
  design, carry no durable state, and are review-loop-fence territory —
  deliberately untouched by Task 120.
- **projectDir-null guard**: several extended-transaction paths skip the
  audit/ledger/events trio when `getProjectDir(project)` returns null. That
  return is only possible when the project row itself is missing
  (`getProjectDir` falls back to `resolveProjectsRoot()/slug` for every real
  row), and `tasks.project_id` is a FK → the row always exists. The guard is
  therefore vestigial/unreachable-in-practice and retained only as
  belt-and-braces; it is NOT a silent-skip of a reachable path.

## 1. transitions.js + _dualwrite.js + delete.js — the 21 lifecycle write paths

Most go through one of the two compensated dual-writers, or extend their own
single transaction with the identical body. The shared dual-writers
(`dualWrite` _dualwrite.js:34, `dualWriteNoGuard` _dualwrite.js:121) are the
ONLY helper mechanism — no second event mechanism exists. The main lifecycle
verbs remain in `transitions.js`; the delete-request approval workflow is
carved into `delete.js` and re-exported through `transitions.js` for API
compatibility.

| # | Path (file:line) | Mutation | Classification |
|---|---|---|---|
| 1 | `createTask` transitions.js:97 | INSERT tasks + audit + genesis ledger/events line | **EMITS-OK** — Task 120 genesis atomicity (carved from 1b): the task folder is created pre-transaction via `resolveOrCreateTaskDir`, the `task_created` line lands in ledger.jsonl AND events.jsonl inside the txn via `appendLedgerAndEvents`; failure removes the created folder (zero residue). No `fs_version` bump (row is born at its initial version; first transition bumps). |
| 2 | `claimTask` transitions.js:225 | UPDATE status→claimed | **EMITS-OK** via `dualWrite` |
| 3 | `resumeTask` (claimed→in_progress) transitions.js:283 | UPDATE status | **EMITS-OK** via `dualWrite` |
| 4 | `resumeTask` (rejected→in_progress) transitions.js:283 | UPDATE status | **EMITS-OK** via `dualWrite` |
| 5 | `reportProgress` transitions.js:357 | UPDATE status (auto-advance) + INSERT progress_reports + journal mirror | **EMITS-OK** — extended-transaction pattern (nested `db.transaction` would deadlock on bun:sqlite): same body as dualWrite incl. `bumpFsVersion` + audit + `appendLedgerAndEvents`, with `resolveOrCreateTaskDir`/`removeCreatedTaskDir` compensation. |
| 6 | `submitTask` transitions.js:510 | UPDATE status→submitted | **EMITS-OK** via `dualWrite` |
| 7 | `requestVerification` transitions.js:615 | UPDATE status→review | **EMITS-OK** via `dualWrite` |
| 8 | `approveTask` transitions.js:679 | UPDATE status→approved | **EMITS-OK** via `dualWrite`. Post-commit extras: optional `insertTaskComment` (annotation row, see §5), `renameOnApprove` (folder rename, see §3), `syncFiles` (render, see §4). |
| 9 | `rejectTask` transitions.js:735 | UPDATE status→rejected + rejection_count + comment row | **EMITS-OK** — extended-transaction pattern (comment insert is in-txn, swallowed-on-failure as a non-essential annotation; the EVENT append is compensated and last). |
| 10 | `updateTask` transitions.js:848 | UPDATE title/desc/priority/tags/metadata | **EMITS-OK** via `dualWriteNoGuard` |
| 11 | `cancelTask` transitions.js:939 | UPDATE status→cancelled | **EMITS-OK** via `dualWrite` |
| 12 | `failTask` transitions.js:993 | UPDATE status→failed | **EMITS-OK** via `dualWrite` |
| 13 | `requestTaskDelete` delete.js:38 | UPDATE metadata (delete flag) | **EMITS-OK** via `dualWriteNoGuard` (`task_delete_requested`) |
| 14 | `approveTaskDelete` delete.js:236 → `performApprovedTaskDelete` delete.js:174 | DELETE tasks row + folder rename " (deleted)" | **EMITS-OK** — D3 ordering, see §2. |
| 15 | `denyTaskDelete` delete.js:270 | UPDATE metadata (clear flag) | **EMITS-OK** via `dualWriteNoGuard` (`task_delete_denied`) |
| 16 | `approveAllTaskDeletes` delete.js:306 | per-row DELETE + rename | **EMITS-OK** — runs the SAME `performApprovedTaskDelete` core per row (one mechanism); a failing row is skipped loudly (swallow telemetry) and left fully intact, the batch proceeds. |
| 17 | `denyAllTaskDeletes` delete.js:358 | per-row UPDATE metadata | **EMITS-OK** — per-row `dualWriteNoGuard`, same as #15. |
| 18 | `releaseTask` transitions.js:1040 | UPDATE status→pending, owner cleared | **EMITS-OK** via `dualWrite` (`task_released`) |
| 19 | `reassignTask` transitions.js:1091 | UPDATE status→pending, owner set | **EMITS-OK** via `dualWrite` (`task_reassigned`). Post-commit `insertTaskComment` annotation (§5). |
| 20 | `commentTask` transitions.js:1157 | INSERT task_comments | **EMITS-OK** via `dualWriteNoGuard` with `bumpVersion:false` — deliberate: a bare comment changes NO task.json-projected column, so bumping `fs_version` would push the DB falsely "strictly ahead" and corrupt the §4 version-gated reconcile. The audit row + events line are still written (parity). |
| 21 | `reopenTask` transitions.js:1221 | UPDATE status→pending | **EMITS-OK** via `dualWrite`. Post-commit extras: `renameOnRejectOrReopen` (folder rename, §3) + `insertTaskComment` (post-commit annotation — **EXEMPT**, §5). The EVENT (`task_reopened`) lands in-txn; the comment row is a best-effort annotation appended after commit, swallowed on failure. |

## 2. The approved-delete ordering argument (D3)

`performApprovedTaskDelete` (delete.js:174), shared by #14 and #16:

1. **Secure the " (deleted)" folder BEFORE the transaction**
   (`secureDeletedFolder` delete.js:101). The DB row is needed to
   resolve the folder and is GONE after `hardDeleteTask`, so the folder must
   be secured first. Fail-loud + fully compensable:
   live folder → `renameSync` (throw aborts before ANY DB mutation; undo =
   rename back); absent folder → CREATE the " (deleted)" folder (D4
   create-or-fail-loud); already-" (deleted)" → reuse (idempotent).
2. **One SQLite transaction**: `insertAudit` FIRST (audit_log.task_id
   REFERENCES tasks(id) ON DELETE CASCADE — inserting after the DELETE would
   violate the FK; the CASCADE then removes the audit row together with the
   task row at commit, leaving **ledger.jsonl + the renamed folder's
   events.jsonl as the durable trail** — this is by design), then the
   compensated `appendLedgerAndEvents` (the `task_deleted` EVENT is on disk
   BEFORE the row removal), then the GUARDED `hardDeleteTask` LAST.
3. **Failure**: ledger.jsonl + events.jsonl are restored byte-exact — by
   `appendLedgerAndEvents`'s own compensation when the APPEND failed, or via
   its returned undo handle (held by `performApprovedTaskDelete` for the
   whole transaction; R1) when a LATER step failed (`hardDeleteTask` throw or
   0-changes guard) — SQLite rolled the row + audit back, `undo()` renamed
   the folder back (or removed a created one) — zero residue, the task fully
   intact. The file restore runs BEFORE the folder rename-back (the events
   path lives inside the still-" (deleted)" folder).
4. **Crash window**: between the pre-txn rename and commit the folder is
   " (deleted)" while the row still lives. The folder still carries its
   README frontmatter `task_id`, so `findTaskFolderByUuid`'s frontmatter scan
   re-discovers it and the boot reconciler (§7) repairs the mirror — the
   window is ordered-safe and repairable, never data-lossy.

Final state on success: row gone, folder " (deleted)", events.jsonl inside it
ending with the `task_deleted` line.

## 2b. EVENT append staging + the single accepted residue class (R3, R2 #2)

The gateway runbook expects `ledger.jsonl` to carry the chattr `+a`
append-only attribute (composer.js gate.f07), which makes a ledger line
potentially IMPOSSIBLE to compensate by truncation. `appendLedgerAndEvents`
therefore stages its writes:

1. **events.jsonl FIRST** — a plain file, always truncate-compensable; the
   undo-handle mechanism is unchanged.
2. **ledger.jsonl LAST** — the final fallible FILE operation before the
   SQLite commit. After the ledger append, NO task-folder/event filesystem
   work of any kind happens in ANY caller: every transitions.js / orphan.js
   path invokes `appendLedgerAndEvents` as the final statement of its
   transaction body, and the approved-delete path (`delete.js`, §2) runs only the DB-only
   guarded `hardDeleteTask` after it. This is proven structurally by
   `tests/ledger.staged-writes.test.js` (instrumented call-order on a real
   transition + a static source assertion that no `appendTaskEvents` call
   exists after the `appendLedger` call) together with D1.1/D1.2 (the
   compensated helper is the only EVENT mechanism).
3. **Compensation failures are LOUD** — `restoreLen` no longer swallows: a
   restore that cannot be applied logs a structured
   `[ledger.compensation_failed]` recovery line and throws a hard
   `ledger_compensation_failed` error that the caller surfaces (the
   approved-delete path still completes the folder rename-back first).
4. **The single accepted residue class**: the ledger.jsonl line was appended
   and the SQLite commit then FAILED while the ledger is append-only
   (truncate → EPERM). Result: one phantom ledger line with no matching
   audit_log row (and no events.jsonl line — events are restored first).
   The boot parity check (reconciler.js step 6: `ledger.jsonl` line count vs
   `audit_log` row count per project) detects exactly this class — ledger
   lines > audit rows flags `parity_ok:false` loud for operator recovery.
   Moving the ledger append post-commit was explicitly rejected in review
   (it would un-anchor the EVENT from the transaction entirely).

## 3. lifecycle.js — folder renames + README render

| Path | Classification |
|---|---|
| `renameOnApprove` lifecycle.js:45 | **EXEMPT** — folder renames are NOT EVENTs (Task 120 contract). They run post-commit BY DESIGN: the transition EVENT was already recorded in-transaction; the rename is a cosmetic mirror op. Ordering argument: rename AFTER commit means a rename failure can never strand a committed-DB/missing-EVENT state — failure is swallowed LOUD (`tasks.rename_on_approve_failed` telemetry) and the mirror is repairable (the folder keeps its frontmatter `task_id`, so `findTaskFolderByUuid` + the boot reconciler keep resolving it; a later transition's `syncFiles` re-renders into the found folder). |
| `renameOnRejectOrReopen` lifecycle.js:89 | **EXEMPT** — same argument (strip " (finished)" post-commit, swallowed loud, repairable). |
| `renameOnDelete` lifecycle.js:68 | **EXEMPT** — retained export, but NO LONGER used by the delete path: Task 120 replaced it with the fail-loud, compensable `secureDeletedFolder` (§2). Kept for API compatibility only. |
| `syncTaskFileLifecycle` lifecycle.js:115 | **EXEMPT** — post-commit best-effort README render (creates folder if missing, regenerates README from DB row + journal). Not an EVENT. NEVER throws by contract (a workspace mishap must not turn a committed 200 into a 500); the in-transaction `fs_version` bump guarantees the version-gated reconciler treats a stale render as behind-DB and skips it. |

## 4. _internals.js — syncFiles + the Task 120 folder-resolution pair

| Path | Classification |
|---|---|
| `syncFiles` _internals.js:161 | **EXEMPT** — post-commit re-render: step 1 `syncTaskFileLifecycle` (README), step 2 `writeTaskJson` (task.json projection incl. the already-committed `fs_version`). Best-effort, swallowed loud (`tasks.task_json_sync_failed`); a failed write leaves task.json stale-but-behind (DB fs_version is strictly ahead) which the §4 version gate handles and the boot reconciler repairs. Forced-failure proof: D5(d) test. |
| `resolveOrCreateTaskDir` _internals.js | **Compensated infrastructure** (not itself an EVENT writer) — D4 create-or-fail-loud: resolves the canonical task folder, CREATING it (with a discoverable frontmatter README) when absent so the events.jsonl append always has its target; any fs failure THROWS (never skip). Runs pre-transaction (fs is not transactional); paired with `removeCreatedTaskDir`. R1: it records every NOT-previously-existing ancestor it creates (the phase dir and any missing parents) in `createdDirs` so compensation can remove the whole created chain. |
| `removeCreatedTaskDir` / `removeCreatedParentDirs` _internals.js | **Compensated infrastructure** — removes the folder AND (R1) the phase ancestors created for a transition whose transaction then failed; zero residue on rollback. Parent removal is empty-checked, deepest-first, and only ever touches dirs recorded in `createdDirs` — a pre-existing directory is never removed. Best-effort/never-throws (runs on the error path; the original error must win). |

## 5. Annotation rows (task_comments / task_journal / progress_reports)

| Path | Classification |
|---|---|
| `commentTask` (task_comments) | **EMITS-OK** — see §1 #20. |
| `approveTask` / `reassignTask` post-commit `insertTaskComment` (transitions.js) | **EXEMPT** — optional annotation rows attached AFTER the transition committed; they are not state transitions (no tasks-column change, no projected-field change) and the transition's own EVENT already landed in-txn. Failure swallowed loud. |
| `rejectTask` comment row (transitions.js) | **in-transaction** with the rejection — the `insertTaskComment` runs inside the same `db.transaction` body as the status UPDATE, `bumpFsVersion`, audit, and `appendLedgerAndEvents`; failure is swallowed loud (non-essential annotation; the EVENT already lands). |
| `reopenTask` comment row (transitions.js) | **EXEMPT — post-commit best-effort annotation**: the `insertTaskComment` runs AFTER `dualWrite` commits AND after the post-commit `renameOnRejectOrReopen` attempt; failure is swallowed loud (`tasks.reopen_comment_failed`). The transition's own EVENT (`task_reopened`) already landed in-txn via `dualWrite`. This is the same annotation-row exemption as `approveTask`/`reassignTask` (see row above). |
| `claimOrphan` handoff journal row (orphan.js:259) | **in-transaction** with the adoption flip — `insertTaskJournal` runs inside `db.transaction` and re-throws on failure (the claim is only correct if the handoff entry lands). Covered by §6. |
| `journal.appendJournalEntry` journal.js:47 (POST /tasks/:id/journal) | **EXEMPT** — append-only journal content, NOT a state transition: touches no tasks column (not even updated_at), no task.json-projected field, no fs_version. The entry surfaces in README at the next transition's `syncFiles` render (eventual, by design). Emitting an EVENT per journal line would flood the trail with non-transitions. |
| `reportProgress` `insertProgress` + journal mirror | in-transaction with the transition — §1 #5. |

## 6. orphan.js — the orphan plane (Task 120 D2 carve)

| Path | Classification |
|---|---|
| `orphanTask` orphan.js:66 | **EMITS-OK** — Task 120: extended-transaction pattern; flip + `stampOrphanMetadata` + `bumpFsVersion` + audit + compensated `appendLedgerAndEvents` (`task_orphaned`) in ONE transaction, `resolveOrCreateTaskDir`/`removeCreatedTaskDir` compensation, `syncFiles` after commit. `stampOrphanMetadata` failure is swallowed in-txn (best-effort enrichment: the flip is still correct without the previous-owner stamp; operators see `tasks.orphan_metadata_stamp_failed`). |
| `claimOrphan` orphan.js:194 | **EMITS-OK** — Task 120: same pattern; adoption flip + handoff journal row (in-txn, throw-on-failure — the claim is only correct if the handoff lands) + `bumpFsVersion` + audit + compensated `appendLedgerAndEvents` (`task_orphan_claimed`), folder compensation, `syncFiles` after commit. |
| `orphan-subscriber.js` | **not a writer** — delegates to `orphanTask` (skipEmit=true affects only the bus notification, never the EVENT trail). |

## 7. reconciler.js — boot-only FS→DB sync (EXEMPT)

`upsertTaskFromFs` (reconciler.js:224) and `updateTaskFromFs` (reconciler.js:277)
write task rows FROM the filesystem. **EXEMPT** — boot-time / admin-triggered
(`POST /v1/api/tasks/reconcile`, **admin-socket-only** — requires both
`CORTEX_FOLDER_AUTHORITY=1` and a Unix-socket connection; TCP returns 403)
maintenance: the filesystem is the source of truth and the DB the derived
index, so the state being written IS the canonical record — emitting an EVENT
would duplicate the very trail it derives from and double-count on replay.
Boot reconcile (scanAll) is unconditional existing behavior and is NOT gated
by CORTEX_FOLDER_AUTHORITY — the flag only enables the D2 manual endpoint.
Dry-run is the safe default (bare POST returns a diff report only; live
recovery requires an explicit `{"dry_run": false}` body); idempotent.

## 8. statements.js raw statements — cross-reference

Every mutating prepared statement and its sole call sites:

| Statement | Caller(s) | Covered by |
|---|---|---|
| `createTask` | transitions.js createTask | §1 #1 |
| `claimTask` | transitions.js claimTask | §1 #2 |
| `claimOrphanedTask` | orphan.js claimOrphan | §6 |
| `orphanTask` | orphan.js orphanTask | §6 |
| `stampOrphanMetadata` | orphan.js orphanTask (in-txn) | §6 |
| `resumeFromClaim` / `resumeFromReject` | resumeTask, reportProgress (in-txn) | §1 #3/#4/#5 |
| `submitTask` | submitTask | §1 #6 |
| `verifyTask` | requestVerification | §1 #7 |
| `approveTask` | approveTask | §1 #8 |
| `rejectTask` / `incrementRejectionCount` | rejectTask (in-txn) | §1 #9 |
| `reopenTask` | reopenTask | §1 #21 |
| `cancelTask` | cancelTask | §1 #11 |
| `failTask` | failTask | §1 #12 |
| `requestTaskDelete` | delete.js requestTaskDelete | §1 #13 |
| `denyTaskDelete` | delete.js denyTaskDelete, denyAllTaskDeletes | §1 #15/#17 |
| `hardDeleteTask` | delete.js performApprovedTaskDelete (in-txn, LAST) | §2 |
| `reassignTask` | reassignTask | §1 #19 |
| `releaseTask` | releaseTask | §1 #18 |
| `updateTask` | updateTask | §1 #10 |
| `bumpFsVersion` | _dualwrite.js dualWrite/dualWriteNoGuard + the extended-txn paths | §1, §6 |
| `insertProgress` | reportProgress (in-txn) | §1 #5 |
| `insertTaskComment` | commentTask (in-txn), rejectTask (in-txn), reopenTask (post-commit annotation — EXEMPT, §5), approveTask/reassignTask (post-commit annotation) | §1, §5 |
| `insertTaskJournal` | reportProgress mirror + claimOrphan handoff (in-txn), journal.appendJournalEntry | §1 #5, §5, §6 |
| `insertAudit` | _dualwrite.js dualWrite/dualWriteNoGuard + extended-txn paths + delete.js performApprovedTaskDelete (all in-txn) | §1, §2, §6 |
| `upsertTaskFromFs` / `updateTaskFromFs` | reconciler.js | §7 |
| `hardDeleteTasksByProject` | project-routes.js approveProjectDelete:207 | **EXEMPT** — project-plane DB-only purge, intentional per review #5 (documented at the call site): no per-task audit/ledger/events, no folder renames; the on-disk project tree is left in place. Rich project-delete event semantics are a flagged follow-up; Task 120's scope is the task-level lifecycle. |
| `activateTaskLease` / `releaseTaskLease` | subagents/lease.js | **EXEMPT** — leases explicitly NOT in Task 120 scope (contract). They touch only lease_token/lease_expires_at/updated_at, never status/ownership. |
| `deletePhaseByOrdinal` / `compactPhaseOrdinals` | phase-routes.js deletePhase:79 | **EXEMPT** — phase-plane operation; child tasks are un-bucketed via the FK's ON DELETE SET NULL (a schema side effect, not a status/content transition). Phase-level event subjects are out of scope. |

## 9. Out-of-plane / pointer-file writers

| Path | Classification |
|---|---|
| `mcp/_task-files.js` (`persistTaskState` / `syncCurrentTaskFile` / `clearCurrentTaskFile`) | **EXEMPT (W5)** — writes ONLY the per-session data/run current-task pointer file (`gateway.config.currentTaskFile`); ZERO canonical task-folder paths (no task.json, events.jsonl, ledger.jsonl, README, no folder ops). Proven by the D6 test in `services/gateway/tests/mcp/_task-files.test.js`. |
| `services/gateway/auth/audit.js` `appendLedger` use (:90) | **EXEMPT** — auth-plane audit lines (subject/payload shape, not the locked task-event schema), appended to the auth audit dir, not a task project dir. Not task state. |
| `scripts/backfill-task-json.mjs` / `scripts/backfill-project-json.mjs` | **EXEMPT** — operator maintenance, dry-run by default, `--write` gated on explicit approval; uses the same projection/write helpers as the live path so output is bit-identical. |
| `services/gateway/lib/summary-writer.js` (`writeSummaryForTask` → `writeSummary`, :346) | **EXEMPT** — post-commit canonical-annotation writer (R1 row): a best-effort `task.submitted` BUS subscriber that renders the DERIVED summary.md into the already-committed task folder — the same class as the README render (§3). It is not an EVENT writer (no ledger/events line), mutates no task row, and does not interact with `fs_version` (summary.md is not version-gated or projected). Every handler error is swallowed by the subscriber contract and the file is regenerated on the next submit. It must NOT be pulled into the in-transaction guarantees: it reacts to the bus AFTER the transition committed, by which point the transition's own EVENT already landed in-txn — wiring it inside would re-couple the fence-adjacent bus to the write transaction. |
| `services/gateway/subagents/spawn.js` `appendRun` (:129, :282) | **EXEMPT (bounded)** — runs-plane bookkeeping: appends subagent run telemetry (`runs.jsonl`) in lockstep with the `subagent_runs` row (the C3 dual-write). runs.jsonl is a canonical task-folder FILE but mirrors the runs table, not the tasks table: no task status/ownership/content, no `fs_version` interaction, not projected into task.json. The runs/lease plane is explicitly outside the Task 120 contract (same boundary as `activateTaskLease`/`releaseTaskLease` §8). Bounded: append-only, run_id-keyed telemetry; readers tolerate torn lines. |
| `scripts/import-v1-data.js` (INSERT tasks :118, progress_reports :184, task_comments :206) | **EXEMPT (bounded, operator)** — one-shot offline v1→v2 migration run by the operator against explicit source/target DB paths; never loaded by the gateway process. `INSERT OR IGNORE` (idempotent re-run). The imported rows ARE the historical record being restored — no transition occurs, so no EVENT is owed (same argument as the boot reconciler §7: writing the canonical record is not transitioning it). |
| `scripts/backfill-approved-at.sh` (UPDATE tasks :36) | **EXEMPT (bounded, operator)** — interactive operator maintenance (prints before/after counts, explicit y/N confirm) backfilling NULL `approved_at` from `updated_at` on already-`approved` rows via sqlite3, offline. Touches no status/ownership/projected content; the approval transition that owns the EVENT already happened (it predates the approved_at column). |
| `ledger.js` write helpers (`writeProjectJson`, `writePhaseJson`, `writeTaskJson`, `writeSummary`, `appendRun`, `writeVerification`) | **library functions**, not paths — every PRODUCTION caller is explicitly enumerated: `syncFiles` §4 + reconciler §7 + backfill scripts (`writeTaskJson` / `writeProjectJson`), summary-writer above (`writeSummary`), subagents spawn above (`appendRun`), auth audit above (`appendLedger`), and the transitions/orphan EVENT paths §1/§6 (`appendLedgerAndEvents`). `writePhaseJson` / `writeVerification` have NO production caller under services/gateway/ or scripts/ (callers live in bot event-wrappers, outside this plane). The D1.7 discovery test diff-checks this enumeration repo-wide — an unlisted writer fails CI. |
| `scripts/preflight-review.mjs` (`preflight-report.md` via `writeFileSync`, temp clone/worktree dirs via `mkdirSync`) | **EXEMPT (TE-1 preflight evidence)** — standalone operator gate run before `request_verification`. Writes durable evidence ONLY to the task folder's `preflight-report.md` and posts a task comment through the gateway; it does not mutate task rows, status, ownership, `fs_version`, `task.json`, `events.jsonl`, or `ledger.jsonl`. Ephemeral temp clone/worktree directories are created under `$TMPDIR` and cleaned in the finally path. |
| `scripts/cortex-digest.mjs` (`writeDigest` → `writeFileSync` + `renameSync`) | **EXEMPT (W6, run-state cache)** — digest cache writer: writes ONLY `data/run/digest/<agent>.md` (run-state, not canonical task data). Detected by D1.7 because its `getWatchPaths` helper references `ledger.jsonl` in production code (to build the watch set) and `writeDigest` uses `writeFileSync` + `renameSync` for atomic write to the digest file. The target path (`data/run/digest/`) is NOT a canonical task-folder path (no task.json, events.jsonl, ledger.jsonl, summary.md, runs.jsonl, verification.json, README.md) — `data/run/` is the ephemeral run-state tree, not the project-data tree. Zero interaction with task rows, `fs_version`, audit_log, or the EVENT trail. |
| `scripts/nli-backfill-eval.mjs` (`atomicAppendPredictions` via `writeFileSync`+`renameSync`, scorecard `writeFileSync`) | **EXEMPT (run-state, Pilot A shadow eval — bounded)** — writes ONLY to `data/run/shadow/eval-holdout.jsonl` and a task-folder `backfill-scorecard.md` (or fallback `data/run/shadow/backfill-scorecard.md`). Detector trigger: `run-state-writer` — names `eval-holdout.jsonl` (matched by `RUN_STATE_FILE_RE`) and uses a write op (`writeFileSync`/`renameSync`). No task DB state, no `fs_version`, no task.json/ledger.jsonl/events.jsonl writes. RUN-STATE EXEMPT class: shadow data lives under `data/run/shadow/`, which is ephemeral operator-visible state, not the canonical task trail. SHADOW-V2: no authority, no gateway coupling, scorecard is read-only measurement output. |
| `scripts/nli-shadow-router.mjs` (`atomicAppendPredictions` via `appendFileSync`) | **EXEMPT (run-state, Pilot A shadow router — bounded)** — writes ONLY to `data/run/shadow/nli-router.jsonl` (O_APPEND predictions log). Detector trigger: `run-state-writer` — names `nli-router.jsonl` (matched by `RUN_STATE_FILE_RE`) and uses `appendFileSync`. No task DB state, no `fs_version`, no task.json/ledger.jsonl/events.jsonl writes. SHADOW-V2: no authority, no gateway writes, pure observer. RUN-STATE EXEMPT class — `data/run/shadow/` is ephemeral operator-visible state. D1.12 proves this entry is discovered and allowlisted. |

## 10. Mechanical claims (checked by tests/writers-inventory.test.js)

1. `transitions.js` and `orphan.js` never call bare `appendLedger(` or
   `appendTaskEvents(` — the compensated `appendLedgerAndEvents` is the only
   EVENT writer they use (single mechanism; no post-commit EVENT emission).
2. Within `services/gateway/tasks/`, only `ledger.js` calls
   `appendTaskEvents` and only `ledger.js` defines/calls `appendLedger`.
3. Every mutating statement name in statements.js (§8 table) appears in this
   document.
4. Every §1/§6 path name appears in this document.
5. `mcp/_task-files.js` contains no reference to any canonical task-folder
   file name (task.json / events.jsonl / ledger.jsonl / README).
6. `renameOnDelete` is no longer referenced by `transitions.js`.
7. **Repo-wide discovery (R1)**: every production file under
   `services/gateway/` and `scripts/` that (a) references a ledger write
   helper, (b) writes a canonical task-folder filename (task.json /
   events.jsonl / ledger.jsonl / summary.md / runs.jsonl /
   verification.json / README.md), or (c) issues raw SQL mutations against
   tasks / task_comments / task_journal / progress_reports is DISCOVERED by
   scan and diffed against an explicit allowlist whose every entry must be
   named in this document. An unlisted discovery — i.e. any future writer
   drift — fails the test; a stale allowlist entry (file gone or no longer
   a writer) also fails, so the list cannot rot in either direction.
