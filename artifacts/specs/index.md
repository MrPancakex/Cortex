---
title: "Spec Documents Index"
date: 2026-04-06
tags: [spec, index]
---

# Spec Documents Index

Extracted from 97 conversation files.

**File location note:** The Cortex security gate (`cortex-gate.sh`) enforces that all writes must stay within `$CORTEX_HOME`. These specs are at `$CORTEX_HOME/artifacts/specs/`.

---

## Product Specifications

| Spec | File | First Date | Versions |
|------|------|-----------|----------|
| Faeline — Spiritual Wellbeing App | [faeline-spec.md](faeline-spec.md) | 2025-09-29 | v0.1 (research), v1.0, v1.1, v1.2 |
| Mythric — Personal Grimoire App | [mythric-spec.md](mythric-spec.md) | 2026-02-18 | V2.1, V3, V3+Product Direction |
| Cortex — AI Operations Platform | [cortex-spec.md](cortex-spec.md) | 2026-02-17 | Product Vision v1.2, Unified v1.2, v1.3, v0.1 ref |

## Agent Specifications

| Spec | File | First Date | Versions |
|------|------|-----------|----------|
| Gerald 2.0 — Autonomous AI Agent | [gerald-spec.md](gerald-spec.md) | Pre-2026-02-05 | V5, V6-V10, Gap Analysis, Runtime |
| Gerald Operational Modes | [gerald-operational-modes-spec.md](gerald-operational-modes-spec.md) | 2026-02-13 | v1 |
| Multi-Agent Tree Workflow | [multi-agent-workflow-spec.md](multi-agent-workflow-spec.md) | 2026-03-13 | v0.2 + critiques |

## Infrastructure Specifications

| Spec | File | First Date | Versions |
|------|------|-----------|----------|
| Bookkeeper Sidecar | [bookkeeper-spec.md](bookkeeper-spec.md) | 2026-02-18 | v1, v2 |
| Accountability Gates / Verification Engine | [accountability-gates-spec.md](accountability-gates-spec.md) | 2026-02-17 | v1, v2 (Claude), v2 (Gerald), Capability Registry, Dynamic Gate |
| Cortex Engine Security | [cortex-engine-security-spec.md](cortex-engine-security-spec.md) | 2026-03-01 | v1 |

---

## Source Conversations by Spec

**Faeline:** `2025-09-29--spiritual-wellbeing-ai-app-research.md`, `2026-02-10--need-help-creating-a-spec-deck.md`, `2026-02-11--faeline-and-neuraclaw-launch-infrastructure.md`

**Mythric:** `2026-02-25--app-mythric-information-retrieval.md`, `2026-02-25--latest-spec-docs-for-cortex-and-gerald.md`, `2026-03-16--market-research-for-mythric-personal-grimoire-app.md`

**Cortex:** `2026-02-17--previous-chat-compilation-review.md`, `2026-02-25--latest-spec-docs-for-cortex-and-gerald.md`, `2026-02-25--enhancing-document-features-for-enterprise-level-product.md`, `2026-03-07--capability-based-verification-architecture-for-cortex.md`, `2026-03-19--ai-routed-dashboard-for-multi-agent-stack.md`, `2026-03-21--cortex-v01-stripped-back-features.md`

**Gerald:** `2026-02-05--converting-gerald-20-document-to-linux-compatible-format.md`, `2026-02-06--document-overhaul-and-optimization.md`, `2026-02-13--operational-modes-for-adaptive-ai-behavior.md`, `2026-02-25--latest-spec-docs-for-cortex-and-gerald.md`

**Accountability Gates:** `2026-02-25--latest-spec-docs-for-cortex-and-gerald.md`, `2026-03-07--capability-based-verification-architecture-for-cortex.md`, `2026-03-07--updating-verify-gate-with-new-variables.md`, `2026-03-09--file-review-with-context-reference.md`

**Bookkeeper:** `2026-02-25--latest-spec-docs-for-cortex-and-gerald.md`

**Security:** `2026-03-01--cortex-ai-agent-security-and-reliability-critique.md`

**Multi-Agent Workflow:** `2026-03-13--multi-agent-tree-workflow-setup-and-enforcement.md`

---

## Spec Evolution Summary

**Faeline / Mythric:** Began September 2025 as "Midnight Oracle" concept. Became formal spec February 2026, growing from 7 features (v1.0) to 23 features (v1.2). March 2026: Mythric split off as its own product identity for the grimoire app.

**Gerald:** Most fragmented — V5 base (29 sections) + V6-V10 addendums (sections 30-59) + gap analysis + connection architecture + operational modes. No single unified document was produced.

**Cortex:** Evolved from microkernel architecture concept through Product Vision v1.2 to Unified Architecture v1.2/v1.3, with three authority domains formalized. v0.1 stripped-back feature set by March 2026.

**Accountability Gates:** Most consistently evolved — v1 (four layers, deployed) → v2 (Domain C) → Capability Registry (dynamic endpoint discovery) → Dynamic Gate (hybrid hardcoded+manifest).

**Bookkeeper:** v1 (three-tier cache, ChromaDB) → v2 (Injection Governance: decay formula, 8K token cap, deduplication, memory pinning).
