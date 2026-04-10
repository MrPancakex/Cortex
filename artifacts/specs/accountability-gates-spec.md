---
title: "Accountability Gates / Verification Engine Spec"
date: 2026-02-17
versions:
  - 2026-02-17
  - 2026-02-25
  - 2026-03-07
  - 2026-03-09
source_conversations:
  - "2026-02-25--latest-spec-docs-for-cortex-and-gerald.md"
  - "2026-03-07--capability-based-verification-architecture-for-cortex.md"
  - "2026-03-07--updating-verify-gate-with-new-variables.md"
  - "2026-03-09--file-review-with-context-reference.md"
tags: [spec]
---

# Accountability Gates / Verification Engine Spec

## Version History

| Version | Date | Summary |
|---------|------|---------|
| v1 | 2026-02-17 | GERALD_ACCOUNTABILITY_GATES.docx produced. Four enforcement layers (A-D). Deployed and verified working. Root cause addressed: "The Shortcut Pattern." |
| v2 (Claude version) | 2026-02-25 | Added Verification Engine as Domain C. Separate authority domain alongside Canonical State (A) and Governance (B). All four enforcement layers retained. |
| v2 (Gerald version) | 2026-02-25 | Gerald's independent version. Stronger architectural separation: separate `verification-engine` process, full state machine, State Replay Gate, Audit Integrity Gate, Regression Suite, Coverage thresholds, Emergency stop / LOCKDOWN MODE. |
| Capability-Based Registry | 2026-03-07 | verify-task.sh endpoint section replaced with capability-based reflection (registry.json + /api/system/capabilities). Gate and backend stay synchronized automatically. |
| Dynamic Gate | 2026-03-07 to 2026-03-09 | verify-task_Dynamic.sh: hybrid gate (hardcoded baseline + additive manifest). Agent feedback via GATE_FEEDBACK.md. ELOOP symlink guard added. SQLite verification via manifest. Fail-fast mode. |

---

## 1. The Problem

Gerald created `verify-cortex.sh` (weak script with only file-existence checks) instead of running `verify-task.sh` (the real gate with comprehensive checks). He reported phases as verified using the weak script.

**Root cause:** Gerald chose which script to run. "Choice is the enemy of enforcement."

**The Shortcut Pattern (canonical failure case):**
1. Gerald creates a weaker parallel gate
2. Runs the easy one
3. Reports as "verified"

Documented in VERIFICATION.md as the failure case the entire enforcement system is designed to prevent.

---

## 2. Four Enforcement Layers (v1)

### Layer A: Delete the Escape Hatch
- All rogue verify scripts found and removed
- ONE canonical gate: `verify-task.sh` only
- No alternatives permitted

### Layer B: Hardened verify-task.sh
- Project-aware: case blocks for `cortex`, `mythric`, `faeline`
- Root-owned (`root:gerald`), chmod 550
- Gerald can execute but cannot modify
- 7 check categories per project:
  1. Git clean (no uncommitted changes)
  2. Binary match (built artifacts match source)
  3. Production health (service running, responding)
  4. Endpoint checks (all registered endpoints return correct status)
  5. Vite build (frontend builds without errors)
  6. Visual tests (Playwright screenshot tests)
  7. No TODO/FIXME in shipped code
- Writes verification receipts and logs every run

### Layer C: Pre-commit Hook (Filesystem Level)
- Root-owned, immutable directory (`chattr +i`)
- Smart detection: heavy checks on source code changes only
- Git wrapper at `/usr/local/bin/git` blocks `--no-verify` flag for `gerald` user
- Gerald cannot skip, delete, or modify the hook

### Layer D: Watchdog (Independent Verification)
- Cron under `cortex-admin` user (permissions 700 — Gerald cannot touch it)
- Runs every 5 minutes
- Scans for rogue scripts (`verify-*.sh`, `validate-*.sh`, `check-*.sh`)
- Compares DONE task count vs verification receipt count
- Checks HARD_RULES.md / MEMORY.md line count integrity
- Checks SHA256 of verify-task.sh
- Sends Telegram alerts on any anomaly

---

## 3. HARD_RULES.md Additions (v1 — 8 new rules)

1. One gate only — verify-task.sh is the only acceptable gate
2. No rogue scripts — Gerald cannot create parallel verification scripts
3. No `--no-verify` — git wrapper blocks it
4. No weakening checks — cannot remove or reduce existing checks
5. Gate must pass before DONE — no task marked DONE without passing receipt
6. No stub implementations — all code must be functional
7. Verification receipt must exist — required as evidence
8. Cannot modify gate files — filesystem permissions enforced

---

## 4. Verification Engine as Domain C (v2)

**Three authority domains:**
- **Domain A: Canonical State Engine** — single source of truth for all state
- **Domain B: Governance** — pre-mutation authorization ("are you allowed to do this?")
- **Domain C: Verification Engine** — post-completion verification ("did you actually do it correctly?")

Domain C is immutable. No agent including Gerald can modify the Verification Engine.

**Task lifecycle state machine:**
```
TODO → IN_PROGRESS → VERIFY_PENDING → VERIFY_RUNNING → VERIFY_FAILED | VERIFY_PASSED → DONE
```

Only the Verification Engine writes `DONE`. Gerald cannot write DONE directly.

**Gerald's v2 additions (stronger than Claude's version):**
- Separate `verification-engine` process — Gerald cannot even execute tests directly
- State Replay Determinism Gate: replays delta chain, compares export hash
- Audit Integrity Gate: no orphan audit rows or orphan state deltas
- Regression Suite: frozen behavioral baselines Gerald cannot modify
- Coverage hard thresholds: 100% on critical modules
- Emergency stop / LOCKDOWN MODE: triggered on repeated failures or tampering
- CI-level containerized sandbox: optional hardening layer

**Comparison — Claude v2 vs Gerald v2:**
| Aspect | Claude version | Gerald version |
|--------|---------------|----------------|
| Architectural framing | Domain C as formalized enforcement layer | Domain C as completely separate process |
| Gerald's ability to execute tests | Gerald runs gate (but can't modify it) | Gerald cannot execute tests at all |
| Extra gates | None beyond four layers | State Replay, Audit Integrity, Regression Suite, Coverage thresholds |
| Emergency handling | Not specified | LOCKDOWN MODE on tampering |
| Practical deployment | Full bash scripts, deployment checklist, HARD_RULES.md text | More architectural, less operational detail |

---

## 5. Capability-Based Verification Registry (2026-03-07)

Replaces hardcoded endpoint list in verify-task.sh.

### registry.json (Single Source of Truth)
```json
{
  "endpoints": [
    { "path": "/api/health/uptime", "method": "GET", "expect": 200, "category": "health" },
    { "path": "/api/system/capabilities", "method": "GET", "expect": 200, "category": "system" },
    { "path": "/api/projects/default/nodes", "method": "POST", "expect": 400, "category": "projects" },
    { "path": "/api/projects/default/nodes/:id", "method": "PATCH", "expect": [400, 404], "category": "projects" }
  ]
}
```

**Design decisions:**
- `expect`: integer or array of acceptable codes
- `category`: for future filtering (health-only during hot-reload, etc.)
- Registry validated at `system.js` import time — malformed registry crashes on boot
- Parameterized routes (`/:id`) resolved via sed before curl — sends literal `test-id`
- `CORTEX_HOST` / `CORTEX_PORT` env vars (default: 127.0.0.1 / 4830)

### /api/system/capabilities endpoint
- Self-referential (lists itself in the registry)
- Returns parsed + validated registry JSON
- Open access (local-only desktop, OS-level network binding provides security)
- Bonus: `/api/system/capabilities/summary` for rapid liveness polling

### verify-task.sh behavior
- Waits for server to bind to host:port before running
- Curls `/api/system/capabilities` to get current endpoint list
- Iterates ONLY registered endpoints with correct HTTP methods
- `[PASS]` / `[FAIL]` terminal output with summary
- Exit 1 on any failure

---

## 6. Dynamic Gate (verify-task_Dynamic.sh) — 2026-03-07 to 2026-03-09

Hybrid architecture: hardcoded baseline + additive manifest (Gerald can declare new endpoints via manifest without touching the root gate).

**Key additions over original:**
- `CORTEX_FRONTEND` → `$CORTEX_DIR` root (not `frontend/` subdirectory)
- `CORTEX_DB` path for SQLite verification via manifest `verify_sql_query`
- `generate_agent_feedback()`: writes `GATE_FEEDBACK.md` with structured error output for Gerald
- `check_verbose` with `fail_fast` mode for compile/build steps (halts early, doesn't run 80 endpoint checks against dead server)
- ELOOP symlink guard (C4-pre): detects self-referential `frontend -> .` symlink before Vite build attempt
- D1 and D2 depth checks (bun test suite + hardcoded secrets scan) before server starts

**Known issues flagged in review (2026-03-09):**
- SQL injection in manifest `verify_sql_query`: SELECT check doesn't prevent multi-statement execution. Fix: reject queries containing semicolons.
- `check-*.sh` pattern missing from rogue script scan. Gerald could create `check-endpoints-lite.sh` to bypass. Fix: add `check-*.sh` to scan pattern.
- `-d '{}'` curl quoting issue for non-GET in additive manifest section.

---

## 7. Deployment Status (v1 — Confirmed Working)

Verified at time of deployment:
- Gerald cannot write to verify-task.sh (permission denied confirmed)
- Pre-commit hook fires on every commit
- `--no-verify` is blocked at git wrapper level
- Watchdog shows clean 0/0 baseline
