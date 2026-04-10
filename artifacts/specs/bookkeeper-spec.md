---
title: "Bookkeeper Sidecar Spec"
date: 2026-02-18
versions:
  - 2026-02-18
  - 2026-02-25
source_conversations:
  - "2026-02-25--latest-spec-docs-for-cortex-and-gerald.md"
tags: [spec]
---

# Bookkeeper Sidecar Spec

## Version History

| Version | Date | Summary |
|---------|------|---------|
| v1 | 2026-02-18 | Full BOOKKEEPER_SPEC_v1.md produced. Three-tier cache architecture. Core principle: "cache first, API never if avoidable." |
| v2 | 2026-02-25 | Added Injection Governance (Part 8). Relevance decay formula, token budget cap, injection ratio, deduplication, memory pinning. Context Rotation Authority framing. Session Resume Block schema defined. |

---

## 1. What It Is

Bookkeeper is a RAG (Retrieval Augmented Generation) cache layer that sits as a sidecar process alongside Gerald's runtime. It indexes session archives and memory files into ChromaDB so Gerald can retrieve specific context without reloading entire conversation histories.

**Core principle:** "cache first, API never if avoidable."

**Renamed concept in v2:** "Context Rotation" replaces "compaction" — rotation implies data moves but stays intact; compaction implies compression/loss.

---

## 2. Architecture

### Three-Tier Cache (CPU-inspired)

| Tier | Contents | Priority | Decay |
|------|----------|----------|-------|
| L1 | Memory files (SOUL.md, MEMORY.md, standing rules) | Highest — always injected | None |
| L2 | Hot sessions (5-6 recent full-fidelity sessions) | High | 7-day half-life |
| L3 | Cold archives (zstd-compressed, still ChromaDB-indexed) | Low (cache miss fallback) | 30-day half-life |

**Compression:** zstd level 19 on cold archives (85-92% size reduction). ChromaDB index preserved when rotating hot→cold — no re-indexing needed.

### Infrastructure
- Runs as separate systemd service under `gerald` user
- Port 4831 (loopback only — not exposed to network)
- Minimum relevance score: 0.6 cosine similarity threshold
- Embeddings: `nomic-embed-text` via Ollama (already installed, $0 cost)

---

## 3. Integration Hooks into Gerald Runtime

All hooks are **fire-and-forget** — Gerald never waits on Bookkeeper:

- `compaction.js` §2.5 — after archive write, before truncation, fire-and-forget notify to Bookkeeper
- `memory.js` §2.6 — on memory write, index entry as L1 priority
- `runtime.js` §2.2 — context request goes through Bookkeeper before API call

**Graceful degradation:** if Bookkeeper crashes, Gerald keeps running. Bookkeeper failure is non-fatal.

---

## 4. Retrieval Priority Order

1. Memory entries tagged `standing_rule` or `decision` (L1)
2. Current project memory (L1)
3. Hot session chunks (L2)
4. Cold archive chunks (L3)
5. Cache miss → new API call

---

## 5. Session Resume Block (v2)

When rotating context, Bookkeeper generates a structured Session Resume Block injected verbatim into the new context window:

```json
{
  "mode": "execution|architecture|strategic|experimental",
  "task_phase": "string",
  "active_files": ["array of file paths"],
  "decisions_made": ["array of decision strings"],
  "open_questions": ["array of open questions"],
  "blocked_on": "string or null",
  "git_branch": "string",
  "budget_consumed": {
    "tokens": 0,
    "cost_usd": 0.0
  }
}
```

---

## 6. Relevance Scoring Formula (v2)

```
score = (cosine_similarity * 0.6) + (recency_weight * 0.2) + (task_match_weight * 0.2)
```

**Recency weight:** `e^(-lambda * days_since)` exponential decay
- Session chunks: 7-day half-life (`lambda = ln(2) / 7`)
- Decision entries: 30-day half-life
- Standing rules / pinned: no decay (weight = 1.0)

**Task match weight:** context relevant to the current task scores higher (semantic similarity to active task description)

---

## 7. Injection Governance (v2 — Part 8)

### Token Budget
- **Cap per session:** 8,000 tokens max retrieved context
- **Max injection ratio:** 12% of context window
- **Chunks per query:** maximum 3

### Constraints
- **Never inject full transcript** — Bookkeeper returns chunks, never whole sessions
- **Session deduplication** — same chunk not injected twice in one session (tracked per session)
- **Maximum injection ratio** — total injected context across all queries in a session bounded at 12%

### Memory Pinning (Always Present)
- **Pinned budget:** 2,000 tokens
- **Pinned content:** project identity, active task definition, critical decisions, standing rules
- Pinned content is always present regardless of relevance scoring — not retrieved, always injected

### InjectionGovernor Class
Manages the injection budget within a session:
- Tracks tokens consumed across all queries in session
- Deduplicates chunks by hash
- Enforces pinned vs dynamic split
- Logs injection events for dashboard

---

## 8. Dashboard Integration

All Bookkeeper metrics flow through EventBus to WebSocket to dashboard:
- Cache hit rate
- Estimated API calls saved (cost savings)
- Sessions indexed (hot count / cold count)
- Storage used
- Last indexed timestamp
- Bookkeeper status (healthy / degraded / offline)

---

## 9. Implementation Dependency

Bookkeeper implementation is locked behind: **Gerald Runtime Phase 2 must be stable first.**

---

## 10. Comparison: Original v1 vs Gerald's Version (v2)

| Feature | v1 (Claude-authored) | v2 (Gerald's version) |
|---------|---------------------|----------------------|
| Domain framing | "Additive cache layer" | "Context Rotation Authority" — promoted to first-class |
| Session Resume Block | "Structured checkpoint" (no schema) | Full JSON schema with 8 fields |
| Relevance scoring | Half-life decay | `(cosine * 0.6) + (recency * 0.2) + (task_match * 0.2)` |
| Injection budget | 12% of context window | 15% of context window |
| Token budget cap | 8,000 tokens | Not explicitly specified |
| "Compaction" terminology | Used | Replaced with "Context Rotation" |

Gerald's version is more architecturally sophisticated. Claude's v1 is more operationally detailed (actual bash deployment scripts, HARD_RULES.md text, deployment checklist with owner assignments).
