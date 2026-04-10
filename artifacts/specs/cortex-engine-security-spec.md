---
title: "Cortex Engine Security Spec — Sandbox, Token Budget, State Sync"
date: 2026-03-01
versions:
  - 2026-03-01
source_conversations:
  - "2026-03-01--cortex-ai-agent-security-and-reliability-critique.md"
tags: [spec]
---

# Cortex Engine Security Spec — Sandbox, Token Budget, State Sync

## Background

A Technical Specification Document for the Cortex core engine was reviewed by a Principal Systems Engineer. The spec described a highly autonomous Gerald agent running within a Tauri app on Linux. Three critical areas were audited:

1. Sandbox Escapes ("God Zone" path jail)
2. Token Bleed / Infinite Loops (PI Agent Execution Loop)
3. State Desync (Bookkeeper Integration)

This document records the flaws found and the architectural fixes required.

---

## 1. Sandbox (God Zone) — Constraints and Fixes

### Constraints
- Enforcement: pure application-layer (Node.js/Tauri backend) — NO OS-level dependencies (no bubblewrap, firejail, Docker)
- Shell access: Gerald gets unrestricted command execution ONLY within CWD `/home/gerald/CortexData/projects/`
- Any traversal attempt or read/write outside the jail: immediate execution kill

### Flaws Found

**P0: String-prefix path checking is trivially bypassed**
- Naive `path.startsWith(JAIL_ROOT)` bypassed by path traversal sequences, null-byte injection, URL-encoded sequences
- Fix: use `path.resolve(candidate)` then strict prefix check on the resolved absolute path

**P0: Symlink attacks completely unaddressed**
- Gerald could write a symlink inside the jail pointing to `~/` — path check passes (resolves inside jail) but operates on host filesystem
- Fix: call `fs.realpath()` before path check; reject any path whose realpath resolves outside jail

**P1: Shell primitive bypasses all path checking**
- Shell commands like `cd ~/ && rm -rf .ssh` have no path component for path-jail.js to intercept
- Shell command string itself is unchecked
- No OS-level sandboxing (chroot, seccomp, etc.)
- Fix: command allowlist and argument sanitizer in Node.js; only permit specific allowed commands (npm, node, git, bun) with sanitized arguments

**P1: Dynamic tool loading from tools directory is an injection surface**
- Tools loaded from directory at runtime; if Gerald can write to that directory, malicious tool executes with full process privileges
- Fix: hash verification or manifest locking for the tool directory

---

## 2. Token Budget and Routing

### Constraints
- Ollama-First: local Qwen 3.5 model via Ollama as primary router (effectively free)
- Cloud Fallback: Claude or DeepSeek triggered only when local model determines task requires high-complexity work
- Circuit Breaker: hard config-defined limits ONLY — no dynamic AI-calculated budgets (AI hallucinates budgets)

### Flaws Found

**P0: No termination condition exists in execution loop**
- Loop condition is "repeat until completion" with no max iterations, no token budget, no wall-clock timeout
- Fix: hard config limits — MAX_ITERATIONS, MAX_TOKENS, WALL_CLOCK_TIMEOUT (e.g., 50 iterations, 100K tokens, 30 minutes)

**P1: No error classification or circuit breaker**
- No distinction between transient errors (network timeout) and permanent errors (syntax error, missing binary)
- Without classification, circuit breaker cannot function correctly — permanent failures get retried indefinitely
- Fix: define error categories with distinct retry policies (0 retries for deterministic failures, max 3 for transient)

**P2 (deferred): Snapshot generation inside loop amplifies cost**
- PROJECT_MAP snapshot generated on every iteration before every provider call
- Large projects: non-trivial filesystem scan every loop tick; token count grows proportionally with project size

**P2 (deferred): Degraded mode undefined**
- Listed as provider fallback with zero specification of actual behavior
- Unclear whether degraded mode means hang, throw unhandled rejection, or graceful failure

---

## 3. State Desync (Bookkeeper Integration) — Fixes

### Constraints
- better-sqlite3 (synchronous) is the mandated SQLite driver
- Atomic write pattern required for all state files

### Flaws Found

**P0: No transactional coupling between filesystem mutation and receipt write**
- Execution order: execute tool call then write receipt (two separate non-atomic operations)
- If process crashes between steps: filesystem mutated but no receipt exists
- On restart: Bookkeeper has no record of what changed — silent split-brain state
- Fix: WAL rollback, compensating transaction, or dirty-state flag; atomic write pattern

**P1: SQLite locking under concurrent tool execution**
- Multiple primitives can generate receipts in rapid succession within one task
- If async SQLite driver is ever substituted: immediate SQLITE_BUSY or SQLITE_LOCKED with no retry logic
- Fix: mandate better-sqlite3 (synchronous) explicitly in spec; add retry/backoff as defense

**P1: PROJECT_MAP.json is a single point of failure and race condition**
- Snapshotter writes to PROJECT_MAP.json directly; process kill mid-write produces a corrupt/partial file
- Next iteration feeds the LLM a broken or empty context
- Fix: write to a temp file then atomic rename — never write directly to destination

**P2 (deferred): Receipt schema entirely unspecified**
- Schema is described as "deterministic" but not defined
- Without a frozen schema (action type, timestamp, input hash, output hash, exit code, file path), receipts cannot reconstruct state or verify retry safety

---

## 4. Priority Summary

| Priority | Flaw | Risk |
|----------|------|------|
| P0 | Shell primitive bypasses all path checking | Host file deletion |
| P0 | Symlink attacks bypass jail | Host file deletion |
| P0 | No loop termination condition | Infinite API token burn |
| P0 | No atomic FS mutation + receipt write | Silent data loss |
| P1 | String-prefix path check naive | Path traversal |
| P1 | No error classification or circuit breaker | Unrecoverable loops |
| P1 | PROJECT_MAP.json non-atomic write | Corrupt LLM context |
| P1 | Dynamic tool loading unsigned | Code injection |
| P1 | SQLite driver not mandated as synchronous | Receipt loss |
| P2 | Degraded mode undefined | Silent task drops |

**Two existential risks:** shell jail escape (host file deletion) and no loop termination (API bill fire).
