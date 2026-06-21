# Ledger Foundation — Schema Lock (Slice A, Phase 2)

> **Status:** LOCKED — 2026-05-25. Implements §A of the master plan.
> Implementors MUST NOT deviate from this document without a new ADR.
> Open questions and unresolved design gaps are in §7.

---

## 1. Purpose

This document defines the typed on-disk schema for the seven ledger files
introduced by Slice A (Ledger Foundation) of the Cortex re-vamp. It exists
to give every downstream implementor — `ledger.js`, `reconciler.js`,
`_internals.js`, the migration, and Slice B's sub-agent runtime — a single
authoritative reference that they can implement against without needing to
read each other's code.

The invariants this schema preserves are:

1. **Recoverability.** After a complete loss of `state/cortex.db`, every
   task row can be reconstructed from `task.json` + `ledger.jsonl` alone,
   without human intervention.
2. **Dual-write consistency (C3).** Every DB state transition appends an
   event to `ledger.jsonl` and writes an `audit_log` row inside the same
   SQLite transaction. Either both succeed or neither does; the ledger and
   the audit log are always in agreement after any committed transition.
3. **Filesystem wins on conflict.** On the rare occasion that `ledger.jsonl`
   and `audit_log` disagree (possible only after an outage hand-edit or a
   failed-mid-flight dual-write), the reconciler treats `task.json` as
   authoritative and rewrites the DB row from it. This is a deliberate
   policy choice: the DB is the derived index, the files are the truth.

---

## 2. File-by-File Schemas

### 2.1 `project.json`

**Path pattern:** `<projectRoot>/project.json`

Where `<projectRoot>` is the value of `projects.root_path` or
`resolveProjectsRoot()/<slug>/`. Example:
`$CORTEX_HOME/projects/cortex-v03/project.json`

**Written:** Rewritten on create and on any project-level field change.
Not append-only.

**Schema (JSONC):**

```jsonc
{
  // Required fields
  "schema_version": 1,                  // integer — always 1 for this schema rev
  "id": "uuid-v4",                      // string — mirrors projects.id (UUID)
  "slug": "cortex-v03",                 // string — filesystem slug (matches folder name)
  "name": "Cortex Re-vamp 2026-05",     // string — human name; mirrors projects.name
  "description": "...",                 // string | null — mirrors projects.description
  "root_path": "$CORTEX_HOME/projects/cortex-v03", // string — absolute path on disk
  "status": "active",                   // enum: "active" | "paused" | "done" | "archived"
  "created_at": "2026-05-25T00:00:00Z", // string — ISO 8601; mirrors projects.created_at
  "updated_at": "2026-05-25T12:00:00Z", // string — ISO 8601; mirrors projects.updated_at
  "phases": ["phase-1","phase-2"],      // string[] — ordered phase folder names (derived)

  // Optional fields
  "metadata": {}                        // object | null — pass-through of projects.metadata
}
```

**Concrete example (cortex-v03):**

```json
{
  "schema_version": 1,
  "id": "cortex-v03-uuid-placeholder",
  "slug": "cortex-v03",
  "name": "Cortex Re-vamp 2026-05",
  "description": "Ledger-style re-vamp: typed fs-truth, bounded sub-agents, provider abstraction",
  "root_path": "$CORTEX_HOME/projects/cortex-v03",
  "status": "active",
  "created_at": "2026-05-25T00:00:00Z",
  "updated_at": "2026-05-25T12:00:00Z",
  "phases": ["phase-1", "phase-2", "phase-3", "phase-4", "phase-5", "phase-6", "phase-7"],
  "metadata": { "sub_projects": ["A","B","C","D","E","F","G"] }
}
```

**DB projection:** All fields except `schema_version` and `phases` mirror
columns in `projects`. `phases` is derived by calling `listPhases` at write
time and converting ordinals to `phase-N` strings. `status` is not a
current `projects` column — it is stored in `projects.metadata.status` and
projected up to the top level in `project.json`. The writer reads
`metadata.status` from the DB row before writing.

---

### 2.2 `phase.json`

**Path pattern:** `<projectRoot>/tasks/phase-<N>/phase.json`

Example: `$CORTEX_HOME/projects/cortex-v03/tasks/phase-1/phase.json`

**Written:** Rewritten when a phase is created, updated, or when a task is
added to the phase. Not append-only.

**Schema (JSONC):**

```jsonc
{
  // Required fields
  "schema_version": 1,       // integer — always 1 for this rev
  "id": "uuid-v4",           // string — mirrors phases.id
  "project_id": "uuid-v4",   // string — mirrors phases.project_id
  "number": 1,               // integer — 1-based; derived via inferPhaseNumber()
  "name": "Foundation",      // string — mirrors phases.name
  "ordinal": 0,              // integer — 0-based; mirrors phases.ordinal directly
  "status": "active",        // enum: "pending" | "active" | "done"
  "created_at": "...",       // string — ISO 8601; mirrors phases.created_at if present
  "task_ids": ["uuid-1"]     // string[] — task UUIDs in this phase (derived from tasks WHERE phase_id=?)
}
```

**Concrete example:**

```json
{
  "schema_version": 1,
  "id": "a1b2c3d4-0001-0000-0000-000000000000",
  "project_id": "cortex-v03-uuid-placeholder",
  "number": 1,
  "name": "Ledger Foundation",
  "ordinal": 0,
  "status": "active",
  "created_at": "2026-05-25T00:00:00Z",
  "task_ids": [
    "aaaaaaaa-0001-0000-0000-000000000001",
    "aaaaaaaa-0001-0000-0000-000000000002"
  ]
}
```

**DB projection:** `id`, `project_id`, `ordinal`, `name`, `status` mirror
`phases` table columns. `number` is `ordinal + 1`. `task_ids` is derived
from `SELECT id FROM tasks WHERE phase_id = ?` at write time.

---

### 2.3 `task.json`

**Path pattern:** `<projectRoot>/tasks/phase-<N>/Task <num> - <title>/task.json`

Example:
`$CORTEX_HOME/projects/cortex-v03/tasks/phase-1/Task 1 - Schema lock/task.json`

**Written:** Rewritten on every call to `syncFiles(taskId)` (the existing
hook at `_internals.js:62`). Not append-only. This is the primary fs-truth
file for a task — README.md is regenerated from it, not the other way around.

**Schema (JSONC):**

```jsonc
{
  // Identity (required)
  "schema_version": 1,              // integer — always 1 for this rev
  "id": "uuid-v4",                  // string — mirrors tasks.id
  "project_id": "uuid-v4",          // string — mirrors tasks.project_id
  "phase_id": "uuid-v4",            // string | null — mirrors tasks.phase_id (FK)
  "phase_number": 1,                // integer — resolved via inferPhaseNumber(); 1-based
  "folder_path": "/abs/path",       // string — absolute path to THIS task's directory on disk

  // Core task fields (required)
  "title": "Schema lock",           // string — mirrors tasks.title
  "status": "in_progress",          // enum — see §2.3a for full allowed set
  "priority": "high",               // enum: "critical" | "high" | "medium" | "normal" | "low"

  // Assignment (required; null when unassigned)
  "assigned_to": "nova",           // string | null — mirrors tasks.assigned_to
  "created_by": "nova",            // string — mirrors tasks.created_by

  // Timestamps (required; null when not yet reached)
  "created_at": "2026-05-25T00:00:00Z",   // string — ISO 8601
  "updated_at": "2026-05-25T12:00:00Z",   // string — ISO 8601
  "claimed_at": "2026-05-25T10:00:00Z",   // string | null
  "submitted_at": null,                    // string | null
  "approved_at": null,                     // string | null
  "deadline": null,                        // string | null — ISO 8601

  // Content (required; empty string when absent)
  "description": "Lock the 7-file schema for slice A.", // string
  "result": null,                   // string | null — mirrors tasks.result (submit summary)

  // Structured fields
  "tags": [],                       // string[] — mirrors tasks.tags JSON column
  "section": null,                  // string | null — projected from tasks.metadata.section
  "rejection_count": 0,             // integer — mirrors tasks.rejection_count
  "parent_task_id": null,           // string | null — mirrors tasks.parent_task_id

  // Reviewer (projected from metadata)
  "reviewer_agent": null,           // string | null — projected from tasks.metadata.reviewer_agent

  // Provider context (optional; populated by Slice B)
  "provider": null,                 // string | null — e.g. "claude-code", "codex-cli"

  // Lease (optional; non-null while a lease is active)
  "lease_token": null,              // string | null — mirrors tasks.lease_token
  "lease_expires_at": null,         // string | null — ISO 8601

  // Fs sync metadata
  "fs_version": 0                   // integer — monotonic counter; bumped on every writeTaskJson
}
```

**§2.3a — status enum (live values from `state/cortex.db`):**

```
"pending" | "claimed" | "in_progress" | "submitted" | "review"
| "approved" | "rejected" | "cancelled" | "failed" | "orphaned"
```

NOTE: The master plan's schema sketch listed `"verified"` as a status value.
That status does not exist in the live `tasks` table or the live state
machine. The review gate is the `"review"` status; `"approved"` and
`"rejected"` are the terminal verdicts. See §7.1 for the plan-vs-live flag.

**Concrete example (Slice A Phase 2 task):**

```json
{
  "schema_version": 1,
  "id": "aaaaaaaa-0001-0000-0000-000000000001",
  "project_id": "cortex-v03-uuid-placeholder",
  "phase_id": "a1b2c3d4-0001-0000-0000-000000000000",
  "phase_number": 1,
  "folder_path": "$CORTEX_HOME/projects/cortex-v03/tasks/phase-1/Task 2 - Schema lock 7-file ledger",
  "title": "Schema lock 7-file ledger",
  "status": "in_progress",
  "priority": "high",
  "assigned_to": "nova",
  "created_by": "nova",
  "created_at": "2026-05-25T00:00:00Z",
  "updated_at": "2026-05-25T11:00:00Z",
  "claimed_at": "2026-05-25T10:00:00Z",
  "submitted_at": null,
  "approved_at": null,
  "deadline": null,
  "description": "Finalize the 7-file typed schema for Slice A. Output: LEDGER-SCHEMA.md.",
  "result": null,
  "tags": ["slice-a", "design"],
  "section": "Ledger Foundation",
  "rejection_count": 0,
  "parent_task_id": null,
  "reviewer_agent": null,
  "provider": null,
  "lease_token": null,
  "lease_expires_at": null,
  "fs_version": 3
}
```

**DB projection:**

| `task.json` field  | DB source                                   | Direction |
|--------------------|---------------------------------------------|-----------|
| `id`               | `tasks.id`                                  | DB → fs   |
| `project_id`       | `tasks.project_id`                          | DB → fs   |
| `phase_id`         | `tasks.phase_id`                            | DB → fs   |
| `phase_number`     | `inferPhaseNumber(task)` at write time      | derived   |
| `folder_path`      | resolved by `syncTaskFileLifecycle`         | derived   |
| `title`            | `tasks.title`                               | DB → fs   |
| `status`           | `tasks.status`                              | DB → fs   |
| `priority`         | `tasks.priority`                            | DB → fs   |
| `assigned_to`      | `tasks.assigned_to`                         | DB → fs   |
| `created_by`       | `tasks.created_by`                          | DB → fs   |
| `*_at` timestamps  | `tasks.*_at`                                | DB → fs   |
| `description`      | `tasks.description`                         | DB → fs   |
| `result`           | `tasks.result`                              | DB → fs   |
| `tags`             | `tasks.tags` (parsed JSON)                  | DB → fs   |
| `section`          | `JSON.parse(tasks.metadata).section`        | DB → fs   |
| `rejection_count`  | `tasks.rejection_count`                     | DB → fs   |
| `parent_task_id`   | `tasks.parent_task_id`                      | DB → fs   |
| `reviewer_agent`   | `JSON.parse(tasks.metadata).reviewer_agent` | DB → fs   |
| `lease_token`      | `tasks.lease_token`                         | DB → fs   |
| `lease_expires_at` | `tasks.lease_expires_at`                    | DB → fs   |
| `fs_version`       | `tasks.fs_version`                          | DB → fs (bumped on each write) |
| `schema_version`   | constant 1                                  | hardcoded |
| `provider`         | not in DB yet — Slice B adds it             | stub null |

---

### 2.4 `summary.md`

**Path pattern:** `<projectRoot>/tasks/phase-<N>/Task <num> - <title>/summary.md`

**Written:** Rewritten on each `report_progress` call with `stage=testing`
or on `submit_result`. In Slice A, this file is written as an empty stub
(`# <title>\n\n_Summary pending._\n`) by `writeTaskJson`'s companion call
so that the file exists for sub-agents that expect it. The real summarizer
(Bookkeeper / Slice G) overwrites it with meaningful content.

**Format:** Markdown. Hard size cap: 2048 bytes (2 KB). The cap is enforced
by the writer, not the schema — the writer truncates to the last complete
paragraph boundary below 2048 bytes before writing.

**Structure:**

```markdown
# <task title>

**Status:** <status>
**Assigned:** <assigned_to or "unassigned">
**Phase:** <phase_number> / **Section:** <section or "General">

## What was done

<one paragraph — at most 400 words — summarising completed work>

## Outstanding

<bullet list — at most 5 items — of what remains or what the next agent must pick up>

## Key files changed

<bullet list — at most 10 items — of absolute paths most relevant to the task>
```

**DB projection:** `summary.md` is a derived artifact; it has no direct DB
column counterpart. Its content is generated by Bookkeeper from
`progress_reports`, `task_journal`, and `runs.jsonl`. In Slice A the stub
writer uses only `tasks.title`, `tasks.status`, `tasks.assigned_to`,
`phase_number`, and `metadata.section`.

---

### 2.5 `runs.jsonl`

**Path pattern:** `<projectRoot>/tasks/phase-<N>/Task <num> - <title>/runs.jsonl`

**Written:** Append-only. One JSON line per sub-agent execution. File is
created as an empty file by `writeTaskJson`'s companion in Slice A; appends
are Slice B's responsibility.

**Schema:** Each line is a complete JSON object (no trailing comma,
newline-delimited):

```jsonc
{
  "run_id": "uuid-v4",             // string — unique per execution
  "task_id": "uuid-v4",            // string — parent task UUID
  "ts": "2026-05-25T10:00:00Z",    // string — ISO 8601 start time
  "ended_at": "2026-05-25T10:05:00Z", // string | null — ISO 8601 end time
  "provider": "claude-code",       // string — provider id (matches providers.json in Slice C)
  "model": "claude-sonnet-4-6",    // string — model id as dispatched
  "input_summary": "Implement...", // string — at most 200 chars; trimmed context sent to the sub-agent
  "tokens_in": 12000,              // integer | null — input tokens consumed; null for non-LLM runs
  "tokens_out": 3400,              // integer | null — output tokens produced; null for non-LLM runs
  "cost_usd": 0.0156,              // number | null — USD cost at provider's rate; null for non-LLM runs
  "artifact_path": null,           // string | string[] | null — output file(s) for tool runs; null for LLM runs
  "result": "submitted",           // enum: "submitted" | "failed" | "cancelled" | "budget_exceeded"
  "exit_reason": "task_complete"   // string | null — provider-specific exit code or reason
}
```

**DB projection:** Slice B introduces a `runs` table
(`run_id, task_id, provider_id, model, status, started_at, ended_at,
tokens_in, tokens_out, cost_usd, exit_reason, artifact_path`).
`runs.jsonl` is the canonical truth; the DB `runs` table is the derived
index. The reconciler (Slice A) does NOT reconcile `runs.jsonl` — that is
Slice B's migration shim. In Slice A the file exists but is empty.

Migration 015 (Slice F.1, 2026-05-25) makes `tokens_in`, `tokens_out`,
`cost_usd` nullable in the DB and adds the `artifact_path TEXT` column.
Pre-existing LLM-run rows retain their original `0` values for token/cost
fields. New tool runs insert `NULL` for those fields.

### Run kinds

The `runs` table records two kinds of run:

**LLM run** (Codex, Claude, etc.) — `tokens_in`, `tokens_out`, and `cost_usd`
fields are populated with non-null values; `artifact_path` is null.

**Tool run** (Blender, render-tool, and similar production tools) — `tokens_in`,
`tokens_out`, and `cost_usd` are null; `artifact_path` is populated with
the output file path(s). `artifact_path` may be either a single absolute path
(TEXT) or a JSON-encoded array of paths (`'["path1","path2"]'`) — the column
stores TEXT in both cases; downstream consumers (cockpit, summary-writer)
parse JSON if the value starts with `[`.

A run's "kind" is implicit from the field values, not a dedicated column.
Downstream consumers check `artifact_path IS NOT NULL` to distinguish tool
runs from LLM runs. Do NOT add a `run_kind` column — the implicit shape is
the intentional design.

---

### 2.6 `verification.json`

**Path pattern:** `<projectRoot>/tasks/phase-<N>/Task <num> - <title>/verification.json`

**Written:** Rewritten when verification status changes: created as a stub
on `requestVerification`, updated on `approveTask` and `rejectTask`. Not
append-only.

**Schema (JSONC):**

```jsonc
{
  "schema_version": 1,              // integer
  "task_id": "uuid-v4",             // string — back-reference to the task
  "status": "pending",              // enum: "pending" | "passed" | "failed"
  "reviewer": "orion",              // string | null — agent id of reviewer
  "requested_at": "2026-05-25T11:00:00Z", // string | null — ISO 8601
  "decided_at": null,               // string | null — ISO 8601; set on approve/reject
  "checks": [],                     // Check[] — see sub-schema below
  "feedback": null                  // string | null — reviewer's comment (mirrors review_feedback in metadata)
}
```

**Check sub-schema:**

```jsonc
{
  "name": "journal_complete",      // string — check identifier
  "passed": true,                  // boolean
  "detail": "all 4 types present"  // string | null — human note
}
```

**Concrete example (task in review):**

```json
{
  "schema_version": 1,
  "task_id": "aaaaaaaa-0001-0000-0000-000000000001",
  "status": "pending",
  "reviewer": "orion",
  "requested_at": "2026-05-25T14:00:00Z",
  "decided_at": null,
  "checks": [
    { "name": "journal_complete", "passed": true, "detail": "planning+context+decision+test present" },
    { "name": "no_stubs", "passed": true, "detail": null },
    { "name": "progress_with_files", "passed": true, "detail": "3 progress rows with files_changed" }
  ],
  "feedback": null
}
```

**DB projection:** `status` maps to `tasks.status` (`review` means
`verification.json.status = "pending"`, `approved` means `"passed"`,
`rejected` means `"failed"`). `reviewer` mirrors
`metadata.reviewer_agent`. `feedback` mirrors `metadata.review_feedback`.
`checks` are derived at write time from the `task_journal` completeness
checks already run by `checkJournalCompleteness()`.

---

### 2.7 `ledger.jsonl`

**Path pattern:** `<projectRoot>/ledger.jsonl`

Example: `$CORTEX_HOME/projects/cortex-v03/ledger.jsonl`

**Written:** Append-only. One JSON line per state transition, project-wide.
This is the system-wide event log for a project. It must be written inside
the same SQLite transaction as the `audit_log` row (the C3 dual-write
contract; see §3).

**Schema:** Each line is a complete JSON object:

```jsonc
{
  "ts": "2026-05-25T10:00:00.000Z", // string — ISO 8601 with milliseconds
  "task_id": "uuid-v4",             // string — the task that transitioned
  "project_id": "uuid-v4",          // string — redundant but makes the line self-contained
  "actor": "nova",                  // string — agent id or "system" for reaper-driven events
  "event_type": "task_claimed",     // string — see §6 for full enum per transition
  "from_status": "pending",         // string | null — status before transition (null for create)
  "to_status": "claimed",           // string | null — status after transition (null for non-status ops)
  "data": {}                        // object — event-specific payload; see §6 for per-event shape
}
```

**`data` payload:** Common fields always present: `{ title: string }`.
Additional fields vary by `event_type` — see §6.

**Concrete example (two lines from a cortex-v03 ledger):**

```jsonl
{"ts":"2026-05-25T10:00:00.000Z","task_id":"aaaaaaaa-0001-0000-0000-000000000001","project_id":"cortex-v03-uuid-placeholder","actor":"system","event_type":"task_created","from_status":null,"to_status":"pending","data":{"title":"Schema lock 7-file ledger","priority":"high","created_by":"nova"}}
{"ts":"2026-05-25T10:01:00.000Z","task_id":"aaaaaaaa-0001-0000-0000-000000000001","project_id":"cortex-v03-uuid-placeholder","actor":"nova","event_type":"task_claimed","from_status":"pending","to_status":"claimed","data":{"title":"Schema lock 7-file ledger","assigned_to":"nova"}}
```

**DB projection:** Each `ledger.jsonl` line corresponds to one row in
`audit_log`. The existing `audit_log` schema stores
`task_id, project_id, actor, event_type, payload, created_at`. The
`ledger.jsonl` line is a superset: it adds `from_status`, `to_status`, and
formats `payload` as the `data` object with `title` always present.

**Reconciler parity invariant:** After N successful transitions on project P,
`wc -l <projectRoot>/ledger.jsonl` equals
`SELECT COUNT(*) FROM audit_log WHERE project_id = ?` for that project.

---

## 3. C3 Dual-Write Contract

### 3.1 Transaction pseudocode

The dual-write wraps `stmts.insertAudit` and `appendLedger` (the fs write)
inside a `db.transaction`. Because `bun:sqlite`'s `db.transaction(fn)()`
executes `fn` synchronously and commits only if `fn` returns without
throwing, an `appendFileSync` exception inside `fn` prevents the commit.

**IMPORTANT (see §7.10):** `audit_log` does not yet exist in v0.2 and
`stmts.insertAudit` is not yet in `statements.js`. Both are created by the
Slice A migration (Phase 3) and the `ledger.js` implementation (Phase 4).
The pseudocode below is the target state; it will not compile against the
current codebase until those phases land.

```js
// Pseudocode — placed in transitions.js wrapping every state-mutating call.
// Concrete implementation lives in ledger.js (Slice A Phase 3).

import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDb } from '@cortex/sdk/db';
import { getProjectDir } from './folders.js';
import { getTaskStatements } from './statements.js';

function appendLedger(projectDir, line) {
  // Throws on permission error or full disk — causes transaction rollback.
  appendFileSync(
    path.join(projectDir, 'ledger.jsonl'),
    JSON.stringify(line) + '\n',
  );
}

function dualWrite({ taskRow, eventType, toStatus, actor, data, mutateStmt, mutateParams }) {
  const db = getDb();
  const stmts = getTaskStatements();
  const project = stmts.getProject.get(taskRow.project_id);
  const projectDir = getProjectDir(project);
  if (!projectDir) throw new Error('project_dir_unknown');

  const line = {
    ts: new Date().toISOString(),
    task_id: taskRow.id,
    project_id: taskRow.project_id,
    actor: actor ?? 'system',
    event_type: eventType,
    from_status: taskRow.status,
    to_status: toStatus,
    data: { title: taskRow.title, ...data },
  };

  db.transaction(() => {
    // 1. Mutate task row (WHERE status='X' guard is inside mutateStmt)
    const info = mutateStmt.run(...mutateParams);
    if (Number(info.changes) === 0) throw new Error('state_guard_failed');

    // 2. Insert audit_log row
    stmts.insertAudit.run(
      randomUUID(),
      taskRow.id,
      taskRow.project_id,
      actor ?? 'system',
      eventType,
      JSON.stringify(data),
    );

    // 3. Append ledger line — MUST be last; throw here rolls back steps 1+2
    appendLedger(projectDir, line);
  })();

  // 4. syncFiles is called AFTER the commit (outside the transaction)
  syncFiles(taskRow.id);
}
```

The key ordering constraint: `appendLedger` is step 3, inside the
transaction body. SQLite commits only after the function body returns without
error. If `appendFileSync` throws, SQLite rolls back both the task mutation
and the `audit_log` insert. `syncFiles` (step 4) is outside the transaction
by design — it calls `writeTaskJson`, which is a best-effort operation that
uses `swallow()` and must not hold the DB lock open.

### 3.2 Failure modes

**Case A — disk write fails before SQLite commit.**
`appendLedger` throws inside the transaction. `db.transaction` rolls back
the task mutation and the `audit_log` insert. Nothing is committed to the DB.
The `appendFileSync` call that threw either wrote nothing (EPERM, ENOENT) or
wrote a partial line (ENOSPC mid-write). In the partial-write case, the
final line of `ledger.jsonl` is malformed JSON; the reconciler must detect
and skip trailing malformed lines (scan from the bottom; skip lines that fail
`JSON.parse`). Outcome: no state change visible anywhere. Safe.

**Case B — disk write succeeds, SQLite commit fails.**
`appendFileSync` succeeded; then SQLite's commit step fails (e.g., disk full
on the SQLite journal page, or the DB file became read-only). `appendFileSync`
cannot be retracted. The ledger has a new line; `audit_log` does not.
Outcome: `ledger.jsonl` is one event ahead of `audit_log`. The reconciler
detects this on next boot (ledger line count > audit_log row count), treats
the ledger as authoritative, applies the transition to the DB row, and
inserts the missing `audit_log` row. This is the intentional "fs wins"
recovery path.

NOTE: This case means the dual-write is NOT atomically equivalent to a
two-phase commit. The guarantee is weaker: "after a successful call, both
agree; after a failed call, neither shows the event OR the ledger is one
ahead (resolved on reconcile)." Implementors must not claim ACID atomicity
across the fs boundary.

**Case C — both succeed, then folder rename fails.**
`renameOnApprove`/`renameOnRejectOrReopen` runs AFTER the transaction
(see `transitions.js:approveTask`). The DB row, `ledger.jsonl`, and
`audit_log` all agree. The folder still has its old name. This is a cosmetic
inconsistency only: `findTaskFolderByUuid` in `folders.js` scans
subdirectory front-matter to locate a task by UUID, making the folder name
non-load-bearing. The reconciler does not need to handle renames. The
`folder_path` column is updated by the next `syncFiles` call, which resolves
the current folder name dynamically via `findTaskFolderByUuid`.

**Case D — both succeed, then `syncFiles`/`writeTaskJson` fails.**
`task.json` is stale relative to the DB. On the next reconciler run, the
DB row is ahead of `task.json` (detectable because `tasks.fs_version >
task.json.fs_version`). Reconciler skips this task (DB is authoritative
when it is ahead). On the next `syncFiles` call triggered by any subsequent
transition, `task.json` is regenerated correctly.

### 3.3 Guaranteed post-conditions

After any **successful** transition (mutate + audit_log + ledger all
committed without exception): `ledger.jsonl` and `audit_log` agree for
this project.

After any **failed** transition (exception in the transaction body, including
from `appendLedger`): neither `ledger.jsonl` nor `audit_log` shows the
event. The narrow exception is Case B (disk write succeeded but commit
failed); this state is resolved on next reconciler boot.

---

## 4. Reconciler Contract

### 4.1 Inputs

```js
scanAll({
  projectFilter?: string,  // optional: project slug or project id; omit to scan all
  dryRun?: boolean         // default false; if true, compute and return diff without DB writes
})
```

### 4.2 Algorithm (ordered steps)

1. **Enumerate projects.** Call `stmts.listProjects.all()` (or filter to one
   project if `projectFilter` is set). For each project row, resolve
   `projectDir` via `getProjectDir(project)`. Skip projects where
   `projectDir` does not exist on disk.

2. **Find `task.json` files.** Walk `<projectDir>/tasks/phase-*/`
   directories. For each subdirectory that matches the `Task N - ...` pattern
   (or the legacy UUID-prefix pattern recognised by `findTaskFolderByUuid`),
   look for `task.json`. Skip directories whose base name ends in
   ` (deleted)` — they correspond to hard-deleted tasks and must not be
   re-added to the DB.

3. **Parse `task.json`.** For each found file, parse as JSON. If malformed
   (including a partial-write trailing line), log a warning and skip that
   file. Extract `id` (UUID) and `fs_version`.

4. **Compare against DB.** Call `stmts.getTask.get(id)`:
   - **Row absent:** task is `added` (fs has it; DB does not).
   - **Row present, `tasks.fs_version > task.json.fs_version`:** DB is
     ahead; action is `skipped` (DB is more recent than the file).
   - **Row present, `tasks.fs_version <= task.json.fs_version`:** compare
     field-by-field (content comparison — see §4.5). If any field differs:
     action is `updated`.

5. **Find orphaned DB rows.** For each project, query
   `SELECT id FROM tasks WHERE project_id = ?`. For any `id` that has no
   matching `task.json` on disk AND whose folder (if it exists) does not end
   in ` (deleted)`: action is `orphaned_db_row`. Log a warning. Do NOT
   delete the DB row — deletion is an explicit operator decision.

6. **Reconcile ledger vs `audit_log`.** For each project, compare
   `countLines(<projectRoot>/ledger.jsonl)` against
   `SELECT COUNT(*) FROM audit_log WHERE project_id = ?`.
   - Ledger count > audit_log count: apply the excess ledger lines as
     `audit_log` inserts (Case B recovery from §3.2). Parse each excess
     line and insert with the ledger line's `ts` as `created_at`.
   - Audit_log count > ledger count: log as `ledger_behind` in the diff.
     This indicates an out-of-band DB write that bypassed the dual-write
     contract; raise a warning but do not auto-repair.

7. **Apply changes (unless `dryRun = true`).**
   - **`added` tasks:** Resolve `phase_id` via `phaseIdForProject()` using
     `task.json.phase_number` (which was derived from `inferPhaseNumber()`
     when the file was written). Call `INSERT INTO tasks (...)` from
     `task.json` fields. Set `tasks.folder_path` from the found absolute
     path. Set `tasks.fs_version` to `task.json.fs_version`.
   - **`updated` tasks:** Call `UPDATE tasks SET ... WHERE id = ?` for
     changed fields only. Do NOT update `tasks.updated_at` — preserve the
     on-disk timestamp from `task.json.updated_at`. Update `tasks.folder_path`
     from the current found path. Update `tasks.fs_version` to match
     `task.json.fs_version`.
   - **`orphaned_db_row` tasks:** Record in diff output only. No DB writes.

8. **Return diff** (see §4.3).

### 4.3 Output diff shape

```js
{
  scanned_at: string,            // ISO 8601
  dry_run: boolean,
  projects: {
    [projectId]: {
      added: number,             // task.json found, no DB row
      updated: number,           // task.json found, DB row exists, fields differ
      skipped: number,           // DB ahead of fs (fs_version); no action taken
      orphaned_db_rows: number,  // DB row exists, no task.json on disk (not deleted)
      ledger_behind: number,     // audit_log count > ledger line count
      ledger_recovered: number,  // ledger count > audit_log; audit rows inserted
      tasks: Array<{
        task_id: string,
        action: "added" | "updated" | "skipped" | "orphaned_db_row",
        changed_fields: string[] // non-empty for "updated" only
      }>
    }
  },
  totals: {
    added: number,
    updated: number,
    skipped: number,
    orphaned_db_rows: number
  }
}
```

### 4.4 Conflict resolution

A "conflict" is defined as: a field in `task.json` has a different value
from the same field in the DB row, AND `task.json.fs_version >=
tasks.fs_version`. The `fs_version` guard ensures that when the DB is
legitimately ahead (the normal post-write state between any transition and
the next reconciler pass), the reconciler does not overwrite a newer DB
value with a stale file.

Conflict resolution uses **content-based, field-level comparison**. Mtime
is not used as a conflict signal. Rationale: `mtime` is unreliable across
`git restore`, `rsync`, `scp`, manual `touch`, and any filesystem that
updates mtime only at second granularity. Content comparison is always
correct and, for a project with hundreds of tasks, the comparison overhead
is negligible (each `task.json` is under 4 KB).

**Resolution rule:** When a conflict is detected (content differs AND
`task.json.fs_version >= tasks.fs_version`), fs wins. The DB row is
rewritten from `task.json`. This is the intentional "rebuild from disk after
DB loss" path and the explicit policy from the C3 design decision.

### 4.5 Idempotency proof

After a successful `scanAll({ dryRun: false })` run:

- All `added` tasks are now in the DB with `tasks.fs_version =
  task.json.fs_version`.
- All `updated` tasks have been rewritten in the DB with `tasks.fs_version =
  task.json.fs_version`.

On an immediate second run:

- For every task, `stmts.getTask.get(id)` returns a row.
- `tasks.fs_version === task.json.fs_version` (set in the first run).
- The `fs_version` guard routes all tasks to `skipped` (DB is at least as
  current as the file: `tasks.fs_version >= task.json.fs_version`).
- Content comparison is never reached.
- No DB writes are issued.
- Returned diff: `added = 0, updated = 0, skipped = N`.

The second run produces zero writes. Running it a third time produces the
same result. QED.

The only way a second run would produce writes is if: (a) a concurrent
`syncFiles` call bumped `tasks.fs_version` between runs, causing the file to
be ahead again — this is correct behaviour (new write happened, reconcile
it); or (b) an operator hand-edited `task.json` and bumped `fs_version`
manually — also correct behaviour.

---

## 5. `fs_version` and `folder_path` Columns

### 5.1 Migration scope: one new table + two new task columns

**Revised scope (see §7.10):** The Slice A migration introduces three schema
changes: (a) the new `audit_log` table required by the C3 dual-write
contract, (b) `folder_path TEXT` on `tasks`, and (c)
`fs_version INTEGER NOT NULL DEFAULT 0` on `tasks`. The original plan
description of "two new columns" was based on the assumption that `audit_log`
already existed; it does not (confirmed 2026-05-25).

The existing `tasks` table already carries every field needed to reconstruct
a complete task row from `task.json`: `id`, `project_id`, `phase_id`,
`title`, `description`, `status`, `priority`, `assigned_to`, `created_by`,
`created_at`, `updated_at`, `claimed_at`, `submitted_at`, `approved_at`,
`deadline`, `tags`, `metadata`, `result`, `rejection_count`,
`parent_task_id`, `lease_token`, `lease_expires_at`. No new domain columns
are required beyond the two below.

Two supplementary columns on `tasks` are needed because the DB cannot answer
two reconciler-critical questions cheaply without them:

1. "Has the file on disk changed since the DB row was last synced?" —
   answered by comparing `fs_version` values, avoiding a full JSON read and
   field comparison on every reconciler pass.
2. "Where is this task's folder on disk right now?" — answered by
   `folder_path`, avoiding a recursive directory scan on every API read path
   that needs to locate the task folder.

### 5.2 `fs_version` semantics

- **Column definition:** `fs_version INTEGER NOT NULL DEFAULT 0`
- **Scope:** Per-task. Two tasks in the same project can share the same
  `fs_version` value without conflict.
- **Monotonic:** Starts at 0 on task creation. Incremented by 1 on every
  successful `writeTaskJson` call inside `syncTaskFileLifecycle`. Never
  reset, never decremented.
- **When bumped:** Every time `syncFiles(taskId)` completes a successful
  `writeTaskJson`. Since `syncFiles` is called after every state transition
  via the hook at `_internals.js:62`, `fs_version` tracks how many times the
  task's on-disk representation has been refreshed.
- **Reconciler use:** If `tasks.fs_version > task.json.fs_version`, the DB
  is more recent than the file — reconciler routes the task to `skipped`.
  If `tasks.fs_version <= task.json.fs_version`, the file is at least as
  current as the DB — content comparison runs, and fs wins on any difference.

### 5.3 `folder_path` semantics

- **Column definition:** `folder_path TEXT`
- **Value format:** Absolute path to the task's directory, WITHOUT a
  trailing slash and WITHOUT the ` (finished)` or ` (deleted)` suffix.
  Example: `$CORTEX_HOME/projects/cortex-v03/tasks/phase-1/Task 2 - Schema lock 7-file ledger`
- **Why absolute, not relative to project root:** Folder names change
  (approved tasks get ` (finished)` appended; `renameOnApprove` may run at
  any time). Relative paths would require every reader to know the project
  root AND to handle the suffix variants. Absolute paths are unambiguous and
  directly usable in `fs.existsSync` checks. The `resolveProjectsRoot()`
  precedence can change with `CORTEX_HOME` reconfiguration; absolute paths
  survive that.
- **Suffix stripping convention:** `folder_path` stores the base path
  without ` (finished)`. The actual on-disk folder may have the suffix.
  `findTaskFolderByUuid` handles this transparently by trying both plain and
  ` (finished)` variants before scanning front-matter. Callers of
  `folder_path` who need the actual current name should use
  `findTaskFolderByUuid(phaseDir, taskId)` rather than reading `folder_path`
  directly.
- **When updated:** On every `syncFiles` call after the task folder has been
  created or discovered. After `renameOnApprove`, the `folder_path` stored
  in the DB is momentarily stale (it points to the pre-rename name); it is
  refreshed on the next `syncFiles` call, which re-resolves via
  `findTaskFolderByUuid`. This stale window is acceptable — `folder_path` is
  a cache, not a source of truth.
- **Null initial value:** `folder_path` is null until the first successful
  `syncFiles` call for the task. Code that reads `folder_path` must handle
  null and fall back to `findTaskFolderByUuid` when null.

---

## 6. State Machine Alignment

The table below maps every state-changing operation in `transitions.js` and
`orphan.js` to the `task.json` fields it updates and the `event_type` it
appends to `ledger.jsonl`. Non-status-changing operations that call
`syncFiles` and should produce a ledger event are included at the end.

All rows also write `updated_at` (to the current timestamp) and `fs_version`
(incremented by 1) in `task.json` on every `syncFiles` call.

| # | Operation | From status | To status | `task.json` fields changed (beyond `updated_at`, `fs_version`) | `event_type` | `data` fields |
|---|-----------|-------------|-----------|--------------------------------------------------------------|--------------|---------------|
| 1 | `createTask` | _(none)_ | `pending` | all fields initialised | `task_created` | `{ title, priority, created_by, phase_number }` |
| 2 | `claimTask` | `pending` | `claimed` | `status`, `assigned_to`, `claimed_at` | `task_claimed` | `{ title, assigned_to }` |
| 3 | `claimOrphan` | `orphaned` | `in_progress` | `status`, `assigned_to`, `claimed_at` | `task_orphan_claimed` | `{ title, assigned_to, previous_owner }` |
| 4 | `resumeTask` (from claimed) | `claimed` | `in_progress` | `status` | `task_resumed` | `{ title, from: "claimed" }` |
| 5 | `resumeTask` (from rejected) | `rejected` | `in_progress` | `status` | `task_resumed` | `{ title, from: "rejected" }` |
| 6 | `reportProgress` (auto-advance from claimed) | `claimed` | `in_progress` | `status` | `task_progressed` | `{ title, stage, files_changed_count }` |
| 7 | `reportProgress` (already in_progress) | `in_progress` | `in_progress` | _(status unchanged)_ | `task_progressed` | `{ title, stage, files_changed_count }` |
| 8 | `submitTask` | `in_progress` | `submitted` | `status`, `result`, `submitted_at` | `task_submitted` | `{ title, summary }` |
| 9 | `requestVerification` | `submitted` | `review` | `status`, `reviewer_agent` | `task_review_requested` | `{ title, reviewer }` |
| 10 | `approveTask` | `review` | `approved` | `status`, `approved_at` | `task_approved` | `{ title, reviewer, comment }` |
| 11 | `rejectTask` | `review` | `rejected` | `status`, `rejection_count` | `task_rejected` | `{ title, reviewer, reason, guidance }` |
| 12 | `reopenTask` (from approved) | `approved` | `pending` | `status`, `assigned_to: null`, `claimed_at: null`, `reviewer_agent: null` | `task_reopened` | `{ title, previous_status: "approved", reason }` |
| 13 | `reopenTask` (from rejected) | `rejected` | `pending` | `status`, `assigned_to: null`, `claimed_at: null`, `reviewer_agent: null` | `task_reopened` | `{ title, previous_status: "rejected", reason }` |
| 14 | `cancelTask` | any non-terminal | `cancelled` | `status`, `assigned_to: null` | `task_cancelled` | `{ title, cancelled_by, reason }` |
| 15 | `failTask` | any non-terminal | `failed` | `status` | `task_failed` | `{ title, failed_by, reason }` |
| 16 | `releaseTask` | `claimed` or `in_progress` | `pending` | `status`, `assigned_to: null`, `claimed_at: null` | `task_released` | `{ title, actor, reason }` |
| 17 | `reassignTask` | any non-terminal | `pending` | `status`, `assigned_to`, `claimed_at: null`, `reviewer_agent: null` | `task_reassigned` | `{ title, new_agent, previous_agent }` |
| 18 | `orphanTask` | `claimed`,`in_progress`,`submitted`, or `review` | `orphaned` | `status`, `assigned_to: null` | `task_orphaned` | `{ title, previous_owner, reason }` |
| 19 | `updateTask` | unchanged | unchanged | title, description, priority, tags, or section (whichever changed) | `task_updated` | `{ title, fields_changed }` |
| 20 | `commentTask` | unchanged | unchanged | _(no task.json field changes; syncFiles still runs)_ | `task_commented` | `{ title, author, comment_length }` |
| 21 | `requestTaskDelete` | unchanged | unchanged | _(metadata.delete_requested_at set; not in task.json schema — skip)_ | `task_delete_requested` | `{ title, actor }` |
| 22 | `approveTaskDelete` | any | _(row deleted)_ | _(task.json remains; folder renamed ` (deleted)`)_ | `task_deleted` | `{ title, actor }` |
| 23 | `denyTaskDelete` | unchanged | unchanged | _(metadata flag cleared; not in task.json schema — skip)_ | `task_delete_denied` | `{ title, actor }` |

**Transition count note:** The task brief says "14 transitions". The live
codebase (as of 2026-05-25) has 23 distinct state-modifying operations
across `transitions.js` and `orphan.js` when counting the full set:
`createTask`, `claimTask`, `claimOrphan`, two `resumeTask` variants, two
`reportProgress` paths, `submitTask`, `requestVerification`, `approveTask`,
`rejectTask`, two `reopenTask` variants, `cancelTask`, `failTask`,
`releaseTask`, `reassignTask`, `orphanTask`, `updateTask`, `commentTask`,
`requestTaskDelete`, `approveTaskDelete`, `denyTaskDelete`. The original "14"
in the brief refers to the 14 mutating functions listed in `state-machine.js`'s
Phase 3.0.b header comment (the spec §5.5 count), which predates the
delete-workflow additions and does not count `orphanTask` (which lives in
`orphan.js`, not `transitions.js`). This schema documents all 23 and
implementors should wire all of them.

---

## 7. Open Questions / Deferred to Later Phases

### 7.1 Plan vs live: `"verified"` status does not exist

The master plan's initial `task.json` schema sketch lists
`status: "pending|in_progress|submitted|verified|approved|rejected"`. The
live `tasks` table and state machine have no `"verified"` status. The
nearest equivalent is the `"review"` status (task is awaiting a reviewer
verdict). The terminal verdicts are `"approved"` and `"rejected"`. This
schema uses the live set. If the intent is to introduce `"verified"` as a
distinct status (e.g., a post-review, pre-approval stage), that is a DB
schema change requiring a migration file and an ADR. **Not a Slice A
blocker.** Flag for the plan author.

### 7.2 `summary.md` writer in Slice A — stub only

Slice A's `ledger.js` creates `summary.md` as a stub. Stub guard rule:
if `summary.md` already exists and is more than 32 bytes, do NOT overwrite
it. The real content is Slice G's job (Bookkeeper continuation). This means
`summary.md` will contain `_Summary pending._` for all tasks until Slice G
ships. Acceptable — sub-agents must handle this gracefully.

### 7.3 `runs.jsonl` writer deferred to Slice B

Slice A creates `runs.jsonl` as an empty file. Slice B's `subagent.js`
appends lines. The schema in §2.5 is locked. The reconciler does not
reconcile `runs.jsonl` in Slice A.

### 7.4 `verification.json` stub write trigger

The `verification.json` stub (status=pending, reviewer=null) should be
created when `requestVerification` fires, not at task creation. The stub
creation and the approve/reject updates are Slice A Phase 6 territory
(wiring `syncFiles` expansion). Decision: create stub on
`requestVerification`, update on `approveTask`/`rejectTask`. Implementors
of the `syncFiles` hook expansion should handle this as a conditional write
(only create/update `verification.json` when the task is in `review`,
`approved`, or `rejected` status).

### 7.5 `schema_version` bump strategy

Every JSON file carries `schema_version: 1`. Future breaking changes
increment this. The reconciler and all readers must check `schema_version`
and skip (with a warning) files with an unrecognised value. Migration logic
for `schema_version: 2` is deferred to the phase that introduces breaking
changes. No auto-migration in Slice A.

### 7.6 Outage-protocol tasks (README but no `task.json`)

The outage fallback protocol in `~/.claude/CLAUDE.md` creates task folders
with `README.md` (YAML front-matter) but no `task.json`. The reconciler's
step 2 looks for `task.json` and will not discover these folders. Two
options:

**Option A (recommended for Slice A Phase 5):** Reconciler also scans for
`README.md` in folders that lack `task.json`, parses the YAML front-matter,
seeds a minimal `task.json`, and logs the action as `added_from_readme`.
This requires no change to the outage protocol that operators rely on.

**Option B:** Update `~/.claude/CLAUDE.md` step 1 to write a minimal
`task.json` alongside `README.md` during outages.

Decision is deferred to Slice A Phase 5. **Option A is preferred.**

### 7.7 `(deleted)` folders and reconciler skip rule

The reconciler skips task directories ending in ` (deleted)` (§4.2 step 2).
A task deleted via `approveTaskDelete` has its DB row hard-deleted but its
`task.json` still exists in the renamed folder. The skip rule prevents the
reconciler from re-adding deleted tasks. This is locked. If a
`(deleted)` folder contains a `task.json` and the operator wants to audit
it, they must do so manually — the reconciler never touches `(deleted)`
directories.

### 7.8 `phase.json` and `project.json` write triggers not yet defined

Neither `phase-routes.js` nor `project-routes.js` currently calls a
`syncPhaseFile` or `syncProjectFile` hook analogous to `syncFiles(taskId)`.
These hooks must be added in Slice A Phase 6. Schema is locked (§2.1,
§2.2); hook placement is deferred.

### 7.9 `ledger.jsonl` path vs `~/CortexData/` convention

The master plan's Context section states: _"Ledger root for this re-vamp:
`~/CortexData/projects/<slug>/...`"_ — citing alignment with the
per-service-DB-in-`~/CortexData/` convention. However, the live code in
`folders.js:getProjectDir` resolves project directories under
`resolveProjectsRoot()`, which maps to `projects.root_path` or
`<CORTEX_HOME>/projects/<slug>/` — which in the live deployment is
`$CORTEX_HOME/projects/`. These are different roots. This schema
places `ledger.jsonl` at `<getProjectDir(project)>/ledger.jsonl` following
the locked constraint and the live code. The `~/CortexData/` reference
in the master plan appears to describe a future migration target, not the
current live root. The discrepancy should be resolved as an ADR in Slice A's
documentation step (Phase 8).

### 7.10 `audit_log` table does NOT exist in v0.2 — Slice A must CREATE it

**CONFIRMED finding (2026-05-25):** The `audit_log` table does not exist in
the v0.2 codebase. `queries.js:121` explicitly states:

> "The v0.2 rebuild doesn't yet have a dedicated `audit_log` table — the
> audit trail is derived from the event bus rather than a persistent table."

A grep across `services/gateway/` and `sdk/` confirms:
- There is no `insertAudit` prepared statement anywhere in `statements.js`
- There is no `CREATE TABLE audit_log` in any migration file
- Comments in `orphan.js:77`, `gate/events.js:104`, and `router/events.js:62`
  all reference `audit_log` only speculatively or as a future concern

**Impact on Slice A scope:**

The §5.1 claim that "only two new columns are sufficient" is now corrected
(see §5.1 revision note). The Slice A migration must:

1. CREATE the `audit_log` table with columns:
   `(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, project_id TEXT NOT NULL,`
   `actor TEXT NOT NULL, event_type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL)`
2. Add `folder_path TEXT` column to `tasks`
3. Add `fs_version INTEGER NOT NULL DEFAULT 0` column to `tasks`

The `stmts.insertAudit` prepared statement must be added to `statements.js`
as part of Slice A Phase 3/4 (the `ledger.js` implementation step). The
`dualWrite` pseudocode in §3.1 already correctly names `stmts.insertAudit`;
implementors must add that statement before calling it.

**Reconciler §4.2 step 6 note:** With no pre-existing rows in `audit_log`,
the first reconciler boot on a live deployment will detect
`audit_log count (0) < ledger count (N)` for any project that has accrued
ledger events. The reconciler will correctly classify this as
`ledger_recovered` and backfill `audit_log` from `ledger.jsonl`. This is the
intended bootstrap path — ledger is truth, `audit_log` is the derived index.

**NOT a blocker for Phase 2 (schema design).** Slice A Phase 3 (migration
file) creates the table. Slice A Phase 4 (`ledger.js` implementation) adds
`stmts.insertAudit` to `statements.js` and wires `dualWrite` into
`transitions.js`. Phase 5 (reconciler) depends on Phase 3 having run.
