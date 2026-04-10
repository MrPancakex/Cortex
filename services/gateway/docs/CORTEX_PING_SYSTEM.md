# Cortex Ping System — v0.1 Spec

## Overview

Gateway-native agent notification system. When a task state changes through Cortex, the gateway emits a notification to the target agent via the existing bridge inbox. No dedicated notification polling loops. No sidecars. No filesystem watchers. The gateway already knows what changed — it just needs to tell the right agent.

Agents consume notifications from the existing bridge inbox during normal MCP interaction or explicit inbox checks. This is event emission plus inbox consumption — not true real-time push. True push (WebSocket) is deferred to v0.2.

Principle: Agents do not run dedicated change-detection polling loops. Notifications are emitted by the gateway and consumed from the bridge inbox during normal interaction or explicit inbox reads.

---

## Prerequisites

Before any handler emits notifications:

1. **Register `task_event` in `VALID_MESSAGE_TYPES`.** The gateway will 400-reject any bridge_send call with an unregistered message type. This is a hard blocker — nothing else works until this is done.

2. **Implement shared emitter helper.** All gateway-emitted notifications must use a single internal function — not inline bridge_send calls in each handler. The helper must:
   - Validate target agent and message type
   - Generate event_id (UUID via `crypto.randomUUID()`)
   - Build canonical payload
   - Call bridge_send
   - Catch and log emission failures (non-blocking)

3. **Register system identity for internal emissions.** The shared emitter needs to authenticate its bridge_send calls to the gateway. Register `"cortex-system"` in the token registry as an internal system identity (not a sidecar — no separate process exists). This is the implementation-level sender identity for the bridge_send call — it is NOT the `source_agent` value in the notification payload. The payload `source_agent` is always the logical workflow owner (the agent whose action triggered the state change).

---

## Task Status Enum (Source of Truth)

All status references in this spec use the actual DB constraint values. No aliases, no folder-convention names.

Valid statuses: `pending`, `claimed`, `in_progress`, `submitted`, `review`, `approved`, `rejected`, `cancelled`, `failed`.

These are not a single linear chain. The core happy-path flow is:

```
pending → claimed → in_progress → submitted → review → approved
```

Branch paths exist: `rejected` returns from `review`, `cancelled` and `failed` can occur from multiple states.

**Key distinctions:**

- `submitted` = builder says "work is done." Pre-review state. No reviewer is assigned yet. Does not notify any reviewer.
- `review` = review has been formally requested via `requestReview()`. Reviewer agent is assigned at this point. This is the handoff that triggers reviewer notification.
- `approved` = reviewer accepts the work. Triggers the `(finished)` folder rename as a filesystem convention — but `approved` is the DB status.
- `rejected` = reviewer sends it back. Builder gets notified.

The word "finished" does not appear in the DB schema. It is a folder-naming convention only. This spec never uses it as a status value.

---

## Gateway-Enforced Transition Guards

These are verified from the gateway source code. Line references are from the codebase at time of spec authoring and may shift — function names are the stable identifiers.

| Function | Required Status | Transitions To | Notes |
|----------|----------------|----------------|-------|
| `requestReview()` | `submitted` | `review` | Assigns `reviewer_agent` |
| `approve()` | `review` | `approved` | Returns 409 if not in `review` |
| `reject()` | `review` | `rejected` | Returns 409 if not in `review` |

*Verification references: `requestReview()` at line 524, `approve()` at line 554, `reject()` at line 599.*

You cannot go `submitted → approved` directly. The gateway will 409 it. The `review` state is mandatory.

---

## Architecture

### Approach: Gateway-Native Event Emission

No new services. The gateway is already the point where state changes happen. Notifications are a side effect of writes that already occur.

When a state-changing operation fires in the gateway, the shared emitter helper calls bridge_send with a structured notification to the target agent. Agents read notifications from their existing bridge inbox via MCP — no new transport layer.

### Notification Triggers

This is the exhaustive list for v0.1. Only these four transitions emit notifications:

| Trigger Point | Gateway Function | Event Name | Target Agent | Notes |
|---------------|------------------|------------|--------------|-------|
| Task claimed | `claimTask()` | `task.claimed` | Task creator (resolved from `created_by` field) | Builder has picked up the work |
| Review requested | `requestReview()` | `task.review_requested` | Reviewer agent (caller-specified; currently `"zeus"` by convention in v0.1) | Work is ready for review. Reviewer is assigned at this point. |
| Task approved | `approve()` | `task.approved` | Builder agent (resolved from `assigned_agent` field) | Review passed. `review_notes` may be populated. |
| Task rejected | `reject()` | `task.rejected` | Builder agent (resolved from `assigned_agent` field) | Review failed. `review_notes` populated. |

**Target agent resolution:**

- **Builder agent** is resolved from `assigned_agent`. This field is set when the agent claims the task via `claimTask()` and is always populated by the time review/approve/reject occurs.
- **Task creator** is resolved from `created_by`. This field is set at task creation.
- **Reviewer agent** is caller-specified via the `reviewer` parameter passed to `requestReview()`. The gateway accepts any valid agent ID. In v0.1 the operational convention is `"zeus"` — callers pass this by practice, not by gateway enforcement. Dynamic routing via agent subscriptions or project config is deferred to v0.2.

**What does NOT emit notifications in v0.1:**

- `create_task` — `assigned_agent` is null at creation. No valid target. Deferred until claim.
- `submit_result` — `submitted` is a pre-review state. The builder hasn't requested review yet; no reviewer is assigned. Notification fires on `requestReview()` instead.
- `bridge_send` — A notification about a bridge message is a notification about a notification. Recursive. Cut.
- `pending`, `in_progress`, `cancelled`, `failed` transitions — Low signal for the review loop. Can be added later.

### Canonical Notification Payload

All `task_event` notifications use this schema. One shape, no special-casing per event type.

```json
{
  "event_id": "evt_a1b2c3d4-5678-9012-ef34-567890abcdef",
  "event": "task.review_requested",
  "source_agent": "atlas",
  "target_agent": "zeus",
  "message_type": "task_event",
  "task_id": "task-03",
  "task_path": "projects/cortex/tasks/phase-1/task-03/",
  "project": "cortex",
  "phase": "phase-1",
  "previous_status": "submitted",
  "new_status": "review",
  "actor": "atlas",
  "timestamp": "2026-04-01T22:15:00Z",
  "review_notes": null
}
```

**Field reference:**

| Field | Required | Description |
|-------|----------|-------------|
| `event_id` | Yes | Gateway-generated UUID via shared emitter. Primary dedupe and audit key. |
| `event` | Yes | Transition name: `task.claimed`, `task.review_requested`, `task.approved`, `task.rejected` |
| `source_agent` | Yes | Logical workflow owner — the agent whose action caused the state change. Not the transport layer identity. |
| `target_agent` | Yes | Agent receiving the notification. Resolved from task metadata or hardcoded role. |
| `message_type` | Yes | Always `task_event` for v0.1. Must be registered in `VALID_MESSAGE_TYPES`. |
| `task_id` | Yes | Task identifier from DB. |
| `task_path` | Yes | Filesystem path to task directory. |
| `project` | Yes | Project name. |
| `phase` | Yes | Phase identifier. |
| `previous_status` | Yes | DB status value before this transition. Must match the status enum exactly. |
| `new_status` | Yes | DB status value after this transition. Must match the status enum exactly. |
| `actor` | Yes | Agent or user who performed the action. In v0.1, identical to `source_agent`. Exists for future scenarios where a sub-agent acts on behalf of a parent — the actor (who did the thing) may differ from the source (whose workflow context owns the event). If this distinction proves unnecessary, collapse to one field in a future version. |
| `timestamp` | Yes | ISO 8601 timestamp of the state change. |
| `review_notes` | No | Reviewer comments. Commonly populated on `task.rejected` (rejection reason). May be populated on `task.approved` (optional approval notes). Null for non-review events (`task.claimed`, `task.review_requested`). |

**On event names vs status values:** Event names describe the transition class (`task.review_requested`). Status fields use the persisted DB enum values (`review`). These are independent — the event is what happened, the status is where the task ended up.

### Notification Flow

```
Agent transitions task status via MCP
    1. Gateway validates the transition (enforces status guards)
    2. Gateway persists state change to DB (this is authoritative)
    3. Shared emitter generates event_id (UUID)
    4. Emitter calls bridge_send() with canonical payload
        - target: resolved from task metadata or hardcoded role
        - message_type: "task_event"
    5. Emitter logs success or failure of emission
    → Bridge message row IS the authoritative audit artifact
    → Gateway logs are operational diagnostics only
    → Target agent picks up notification on next inbox check or MCP piggyback
```

This ordering is mandatory. State change persists before notification emits. Notification never fires on an uncommitted state change.

---

## Constraints

1. **No dedicated notification polling loop.** Agents consume notifications from the bridge inbox during normal MCP interaction or explicit inbox checks. No idle token burn. This is not true push — agents must be active to receive.
2. **All notifications route through the bridge.** Single source of truth. Every notification is a bridge message — logged, timestamped, attributed, visible in dashboard.
3. **No new services.** Shared emitter helper inside the existing gateway. No sidecar, no systemd unit, no new process.
4. **Bridge inbox is the only notification channel.** DB-backed, already works, agents already read it via MCP.
5. **No filesystem inbox directories.** Bridge is DB-only. No file-based inbox mirroring — one source of truth, not two.
6. **One emitter function.** All notification emissions go through the shared helper. No inline bridge_send calls in individual handlers. Drift is guaranteed without this.

---

## Delivery and Failure Semantics

Notification emission is non-blocking. The task state write is authoritative — the notification is a best-effort side effect.

**The hard rules:**

- Bridge notification failure does not roll back task state. Ever.
- Failed emission is logged with event_id, target_agent, and error details to gateway logs.
- Retry is manual or deferred to future versions. No automatic retry in v0.1.

**Failure scenarios:**

- **State write succeeds, notification succeeds:** Normal path. Agent gets pinged.
- **State write succeeds, notification fails:** Task state is committed and correct. The target agent won't receive the ping — awareness falls back to later inbox/context discovery or operator intervention. The failed emission is logged with event_id for tracing.
- **State write fails:** No notification is emitted. Nothing happened.

Missed pings are a visibility delay, not data loss — the task is in the correct state regardless of notification delivery, and the underlying task state is always queryable from the DB.

The bridge message row is the authoritative audit artifact. Gateway logs are operational diagnostics only. These are separate concerns — do not treat gateway logs as a second audit source.

---

## Idempotency Contract

Receiving agents must treat notification handling as idempotent by event_id.

**Agent-side dedupe:** Agents track acted-on event_id values for the current session. If an incoming notification matches an already-acted-on event_id, it is acknowledged and discarded. The gateway does not dedupe — it fires and forgets. Deduplication is the receiving agent's responsibility.

**Action idempotency:** Even if dedupe fails and an agent receives the same notification twice, the resulting action must be safe to execute more than once:

- Before acting on a `task.review_requested` notification, the reviewer checks current task status. If the task is already in `approved` or `rejected`, the action is a no-op.
- Before acting on a `task.rejected` notification, the builder checks current task status. If the task is already back in `in_progress` (i.e. already picked back up), the action is a no-op.
- No action should create duplicate review comments, duplicate status transitions, or race conditions.

The pattern: check current state before acting, not just the notification content.

---

## broadcastTaskEvent — Legacy Compatibility

The existing `broadcastTaskEvent` function is a separate event emission path from the bridge notification system described in this spec. It serves dashboard and WebSocket consumers.

**v0.1 stance:** `broadcastTaskEvent` remains operational for dashboard/WebSocket consumers. It is explicitly a legacy compatibility path. It is NOT a notification delivery mechanism for agent-to-agent communication. The bridge notification (via shared emitter) is the sole agent notification path.

If both `broadcastTaskEvent` and the bridge notification fire for the same state change, agents may see the event surfaced through multiple paths (bridge message, piggyback system, broadcast). The dedupe guard (by event_id) handles this — agents ignore events they've already acted on.

**v0.2 consideration:** Collapse `broadcastTaskEvent` into the shared emitter abstraction so all event consumers (dashboard, agents, future subscribers) receive events through one unified path.

---

## What This Covers vs. What It Doesn't

**Covered (v0.1):** The four specific transitions listed in the trigger table — `task.claimed`, `task.review_requested`, `task.approved`, `task.rejected`. These are the transitions that matter for the Atlas → Zeus review loop.

**Not covered (v0.1):** Manual filesystem edits that bypass Cortex entirely (e.g. SSH in and edit a task README directly). The gateway has no visibility into changes it didn't process. This is an operator edge case — you know when you've done it.

---

## Implementation Notes

- Shared emitter helper is the first thing to build. Nothing else works without it.
- Register `task_event` in `VALID_MESSAGE_TYPES` before writing any handler code.
- Register `"cortex-system"` in the token registry as the internal identity used by the shared emitter to authenticate bridge_send calls. This is not a payload field — `source_agent` in the payload is always the acting agent.
- Add emitter call at each of the four trigger points in the gateway handlers: `claimTask()`, `requestReview()`, `approve()`, `reject()`.
- Notifications are fire-and-forget via the emitter's try/catch — log failures, never throw.
- Keep notification messages self-contained — include enough context (previous/new status, actor, task path, review notes) that the receiving agent can act without a follow-up query.

---

## Agent Workflow (Atlas → Zeus Review Loop)

**1. Atlas completes work on task**

Atlas calls `submit_result` via MCP. Gateway transitions: `in_progress → submitted`. No notification emitted (`submitted` is pre-review).

**2. Atlas requests review**

Atlas calls `request_verification` via MCP, specifies reviewer: `"zeus"`. Gateway validates: status === `"submitted"` (enforced by `requestReview()`). Gateway transitions: `submitted → review`. Gateway assigns `reviewer_agent: "zeus"`.

Shared emitter fires to zeus:
```json
{
  "event": "task.review_requested",
  "previous_status": "submitted",
  "new_status": "review",
  "actor": "atlas",
  "review_notes": null
}
```

**3. Zeus checks bridge inbox** (during MCP interaction or explicit check)

Zeus sees `task.review_requested` notification. Checks event_id against acted-on list (dedupe). Checks current task status is still `"review"` (idempotency). Reviews the task artifacts at the specified path.

**4a. If approved:**

Zeus calls `approve` via gateway. Gateway validates: status === `"review"` (enforced by `approve()`). Gateway transitions: `review → approved`.

Shared emitter fires to atlas:
```json
{
  "event": "task.approved",
  "previous_status": "review",
  "new_status": "approved",
  "actor": "zeus",
  "review_notes": "Clean implementation, tests pass"
}
```

Filesystem convention: folder renamed to `(finished)`. Atlas picks up next task.

**4b. If rejected:**

Zeus calls `reject` via gateway. Gateway validates: status === `"review"` (enforced by `reject()`). Gateway transitions: `review → rejected`.

Shared emitter fires to atlas:
```json
{
  "event": "task.rejected",
  "previous_status": "review",
  "new_status": "rejected",
  "actor": "zeus",
  "review_notes": "Auth middleware missing rate limit check"
}
```

Atlas fixes, transitions back to `in_progress`, re-submits. Loop back to step 1.

---

## v0.2 Evolution Path

- **Filesystem watcher sidecar (`cortex-watcher`):** Catches manual edits that bypass the gateway. Uses `inotifywait` on project directories, syncs changes back into gateway awareness. Only needed for the operator edge case.
- **Dynamic target routing:** Replace hardcoded `"zeus"` reviewer with agent subscriptions or project-level config. Agents register interest in event types. Gateway routes based on subscriptions, not fixed agent IDs.
- **Collapse `broadcastTaskEvent`:** Unify all event emission behind the shared emitter so dashboard, agents, and future subscribers all consume from one path.
- **Autonomous task chaining (Flywheel):** On `task.approved`, gateway checks for follow-up task templates and auto-creates the next task. `create_task` via MCP already exists — this adds the autonomous decision layer.
- **WebSocket push:** Replace inbox consumption with real-time push to connected agents. This is what makes the system true push instead of emit-and-consume.
- **Cost ceiling / retry cap:** Max iterations on the review loop to prevent runaway Atlas → Zeus cycles.
- **Notification retry policy:** Optional retry for failed emissions with backoff.
- **Additional trigger points:** Expand beyond the four core transitions as needed (e.g. `task.cancelled`, `task.failed`, `task.assigned`).
- **`create_task` notification:** Emit on creation once assignment-at-creation is supported, or emit on claim as a separate event.

---

## Out of Scope (v0.1)

- Filesystem watcher sidecar (deferred — manual edits are operator-known edge cases)
- Autonomous task chaining (Flywheel self-perpetuation)
- Dynamic target routing / agent self-subscription to event types
- WebSocket push to agents (true real-time push)
- Advanced project-aware routing policies
- Retry/loop caps on review cycles (monitor manually for v0.1)
- Notification retry on emission failure (log-and-continue for v0.1)
- `bridge_notify` message type (notifications about bridge messages are recursive — cut)
- `create_task` notification (no valid target at creation time — deferred)
- `submit_result` notification (`submitted` is pre-review, no reviewer assigned — notification fires on `requestReview()` instead)
