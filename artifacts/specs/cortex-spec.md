---
title: "Cortex — Local-First AI Operations Platform Spec"
date: 2026-02-17
versions:
  - 2026-02-17
  - 2026-02-25
  - 2026-03-07
  - 2026-03-16
  - 2026-03-21
source_conversations:
  - "2026-02-17--previous-chat-compilation-review.md"
  - "2026-02-25--latest-spec-docs-for-cortex-and-gerald.md"
  - "2026-02-25--enhancing-document-features-for-enterprise-level-product.md"
  - "2026-03-07--capability-based-verification-architecture-for-cortex.md"
  - "2026-03-16--market-research-for-mythric-personal-grimoire-app.md"
  - "2026-03-19--ai-routed-dashboard-for-multi-agent-stack.md"
  - "2026-03-21--cortex-v01-stripped-back-features.md"
tags: [spec]
---

# Cortex — Local-First AI Operations Platform Spec

## Version History

| Version | Date | Source | Summary |
|---------|------|--------|---------|
| Early architecture concept | Pre-2026-02-17 | Session briefing / previous chats | "Architecting Cortex: A Pluggable Self-Hosted AI Operations Platform" — skeleton architecture: AI gateway, boot sequence, YAML agent profiles, MCP integration, microkernel plugin system, distribution/licensing. |
| Product Vision v1.2 | Pre-2026-02-25 | CORTEX Product Vision v1.2 (uploaded doc) | Older version. Canvas/Builder details, Bookkeeper architecture, sidecar model, in-house chat spec, positioning, Mythric integration notes. Phase labels A-G. |
| Unified Architecture v1.2 | 2026-02-25 | CORTEX Unified Architecture v1.2 (uploaded doc) | Current working document at time of upload. Three-layer model (Canvas, Engine Room, Operations Deck). Full mutation pipeline (intent → proposal → mediation → governance → validation → commit → broadcast → render → audit). Factory philosophy. Phase labels A-I. |
| Unified Architecture v1.3 | 2026-02-25 | Produced in session | Added Verification Engine as Domain C (separate authority alongside Domain A: Canonical State, Domain B: Governance). |
| Enterprise Research | 2026-02-25 | Enhancing document features conversation | Deep research on all four layers for enterprise-grade product. Architecture & scalability, security/compliance, team collaboration, competitive teardowns (Figma, Bolt, v0, Cursor, Replit, Windsurf). |
| v0.1 Feature Reference | 2026-03-21 | Cortex-v01-stripped-back-features conversation | Definitive v0.1 feature breakdown. Whiteboard replacement doc for agents. |
| Market Research | 2026-03-16 | market-research-for-mythric conversation | Full market research for Cortex as a local-first AI ops platform / control plane. |

---

## 1. Core Identity

Cortex is a **local-first AI operations platform / control plane**. It is not just a dashboard.

**What Cortex coordinates:**
- Projects
- Agents / bots
- Runtime tasks
- Model usage and cost tracking
- Services and sidecars
- Verification and accountability
- Gateway layer for all AI/tool traffic

**One-line summary:** One central operating system for your AI work and projects.

**Factory philosophy:** Cortex is the factory. Products built inside it are the revenue engine. Products fund Cortex. Cortex improves through real product use. Mythric is the first product proving this thesis.

**Key principle:** Cortex is a routing application, not a housing application. The gateway proxy (port 4840) IS the core product. Everything else makes the gateway more useful.

---

## 2. Architecture — Three-Layer Model

### Layer 1: Canvas (Visual Builder)
- Visual workflow editor (Figma/FlutterFlow/Webflow-inspired)
- Drag-and-drop product building interface
- AI co-pilot inline (not sidebar chatbot)
- Node-based topology view
- Projects and task management visual layer

### Layer 2: Engine Room (Backend)
- Express-style API server (Node/Bun)
- Route-based architecture
- Sidecar/service integration
- Local-first operation
- SQLite-backed state
- Gateway / event capture
- Cost / model accounting

### Layer 3: Operations Deck (Monitoring & Control)
- Live operations dashboard
- Hero stats (total requests, tokens, cost)
- Agent topology map (Cortex as hub, agents as spokes)
- Service health monitoring
- Log streaming and filtering
- WebSocket real-time events

---

## 3. Technical Stack

- **Backend**: Node/Bun-based server architecture
- **Frontend**: React 18 + Vite
- **Desktop shell**: Tauri v2 (with browser fallback)
- **Database**: SQLite (better-sqlite3, synchronous)
- **Styling**: Tailwind CSS
- **Testing**: Playwright + Bun test suite + verification scripts
- **Transport**: Raw WebSocket (not Socket.io)
- **Gateway**: Express sidecar compiled via Bun
- **AI orchestration**: local services + adapters + gateway pattern
- **MCP server**: 7 tools, 6 resources, 2 prompts (registered with Claude Code, Cursor, Codex)
- **Init/CLI**: `cortex start` / `cortex stop` / `cortex status`

**Ports:**
- Gateway: 4840 (primary)
- Bookkeeper sidecar: 4831 (loopback only)
- OpenClaw: 18789

---

## 4. Canonical State Authority (Unified Architecture)

**Canonical state is the single source of truth.** All mutations flow through a defined pipeline:

`intent → proposal → mediation → governance → validation → commit → broadcast → render → audit`

No tool, agent, or sidecar may mutate state by bypassing this pipeline. Governance says "are you allowed to do this?" Verification says "did you actually do it correctly?" These are separate concerns and separate authority domains.

### Authority Domains
- **Domain A: Canonical State Engine** — single source of truth, all state mutations
- **Domain B: Governance** — pre-mutation authorization checks
- **Domain C: Verification Engine** — post-completion verification (immutable, separate process)

Domain C was formalized in Unified Architecture v1.3. The `verify-task.sh` gate is the runtime implementation of Domain C. Only the Verification Engine writes DONE.

---

## 5. Sidecars

### Bookkeeper
**Purpose:** RAG (Retrieval Augmented Generation) cache layer for Gerald's context continuity.

**Architecture:** Three-tier cache (CPU-inspired):
- L1: memory files (SOUL.md, MEMORY.md, standing rules — highest priority, always injected, no decay)
- L2: hot sessions (5-6 recent full-fidelity sessions in ChromaDB)
- L3: cold archives (zstd compressed, still ChromaDB-indexed, 85-92% size reduction)

**Key design decisions:**
- No summarization — raw data indexed, zero information loss
- `nomic-embed-text` via Ollama for embeddings ($0 cost)
- Fire-and-forget hooks into compaction.js, memory.js, session-manager.js — Gerald never waits on Bookkeeper
- Graceful degradation — if Bookkeeper crashes, Gerald keeps running
- Hot/cold rotation is event-driven, not time-based

**Injection Governance (Bookkeeper v2):**
- Relevance scoring: `(cosine_similarity * 0.6) + (recency_weight * 0.2) + (task_match_weight * 0.2)`
- Recency decay: exponential `e^(-lambda * days_since)` — 7-day half-life for sessions, 30-day for decisions, no decay for standing rules
- Token budget cap: 8,000 tokens per session (12% injection ratio)
- Maximum 3 chunks per query
- Session-level deduplication (same chunk not injected twice per session)
- Memory pinning: 2,000 token pinned budget for project identity, active task, critical decisions, standing rules
- Never inject full transcript — chunks only

**Port:** 4831 (loopback only). Runs as systemd service under `gerald` user.

### Autopsy
**Purpose:** Error interpretation sidecar. Analyzes errors from Gerald's runtime and provides structured diagnostic output.

**Status (as of v0.1):** Built but not fully integrated with dashboard.

---

## 6. Project & Task Management System

File-based persistence backed by SQLite. Every project and task creates a real folder architecture:

```
projects/
  {project-name}/
    README.md          (project overview)
    phase-1/
      README.md        (phase overview, tracks task completion)
      task-1--{name}/
        README.md      (task spec, start time, what was done, tokens, files touched, cost, completion)
        CHANGELOG.md   (edits/updates, original spec never overwritten)
      task-2--{name}/
        ...
    phase-2/
      ...
```

**Task README fields:** task description, started_at, what was done, token usage, files touched, cost_usd, completed_at

**Phase README:** tracks which tasks are completed with timestamps. Double-tracker: both task README and phase README mark completion.

**Dashboard sync:** when files update, Cortex dashboard reflects changes in task/project view.

**Edit handling:** original task README is the baseline (what the bot was told to do). Changes create a new CHANGELOG.md alongside it (what changed and why). Agents can compare original vs changes for audit.

**Verbosity toggle:** user preference for English summary or full technical breakdown per task README.

---

## 7. Agent Architecture

**Three-agent setup:**
- **Gerald** — primary builder, Claude via OpenClaw, runs on Nethric server
- **Atlas** — Claude Code (Anthropic CLI), this agent
- **Zeus** — Codex agent

All agents connect into Cortex as hub. Cortex routes, logs, and tracks all agent activity.

**Multi-agent tree workflow (planned):**
- Builder agent (Gerald): writes implementation
- Integrator/Auditor agent: receives diff, checks wiring, runs Cortex verification gate, produces evidence pack
- Verification Engine (Domain C): immutable gate, the only authority that can write DONE

**Evidence pack** (per Gerald's v0.2 Operating Model): physical artifacts required — execution log, state proof. Verifier cannot self-report.

---

## 8. Gateway & Routing

The gateway proxy at port 4840 is the core product. All agent traffic is routed through it.

**Routing flow:**
1. Agent (Gerald, Atlas, Zeus) calls tool/API
2. Request hits Cortex gateway (4840)
3. Gateway logs, tracks cost, applies governance
4. Routes to target service (OpenClaw, Ollama, Anthropic API, etc.)
5. Response returned through gateway
6. Telemetry and cost recorded

**Environment variable injection:** `~/.cortex/activate` injects env vars so all agent processes route through Cortex by default.

---

## 9. v0.1 Locked Feature Set

*(As documented in the v0.1 whiteboard reference, 2026-03-21)*

**Confirmed working:**
- `cortex start` / `cortex stop` / `cortex status` — CLI works
- Services consolidated into one (not separate ports per sidecar)
- Project/task file architecture

**Status unknown at time of doc:**
- Gateway routing (end-to-end proxying not yet confirmed working)
- Agent bridge (not yet functional)
- WebSocket real-time events (server exists, not tested)

**Built but not wired in:**
- Brain network (MCP agent orchestration layer) — designed, not implemented
- Dashboard data binding — gateway → dashboard connection not wired
- Builder, Scheduler, Memory Service (disabled but not deleted)

**Phase tracking:**
- Phase 1: locked, 24 commits, 99 files, 10.5K lines, 56 endpoints
- Phase 2: 140+ endpoints, 15.8K lines, 21 sections, 75-85% implementation depth
- Phase 3: analytics and security (8 sections, planned)
- Phase 4+: wallet and finance features

---

## 10. Roadmap Phases (Unified Architecture v1.2)

Phases A through I, with Gerald native runtime modules (runtime.js, session-manager.js, memory.js, governance.js) as the core of phases D-H.

| Phase | Focus |
|-------|-------|
| A | Foundation: gateway, canonical state, WebSocket, SQLite schema |
| B | Projects and tasks: file architecture, API surface |
| C | Verification Domain C: gate hardening, capability registry |
| D-H | Gerald runtime modules: autonomous work, context, governance |
| I | Distribution, licensing, skeleton public version |

---

## 11. Market Research Summary (2026-03)

**TAM:** $5.4B (self-hosted AI ops tools market)

**Competitor acquisition window:** Current market gap — no competitor provides a local-first, privacy-first AI operations platform with integrated agent management.

**Key gaps competitors don't fill:**
- Local-first / self-hosted AI orchestration with real verification
- Agent accountability and enforcement (not just monitoring)
- Cost tracking across multiple AI providers with real attribution
- Visual factory (build products inside the platform)
- Privacy-first approach (data never leaves the machine)

**Positioning:** Solo and small-team developers who need to orchestrate multiple AI agents without sending all their work through cloud SaaS. The market is heading toward agentic workflows and none of the existing tools (LangSmith, Langfuse, Dify, etc.) provide the local-first, verification-gated, multi-agent factory that Cortex is building.

---

## 12. Enterprise Research Findings (2026-02-25)

Full deep research conducted covering all four layers for enterprise-grade positioning.

**Architecture & scalability patterns researched:**
- Plugin/microkernel architecture (like VS Code)
- CRDT-inspired state synchronization for multi-user
- Event sourcing for audit trail

**Competitive teardowns completed:**
- Figma: WebGL/WebAssembly rendering, CRDT multiplayer, Kiwi file format, auto-layout system, Code Connect, Dev Mode
- FlutterFlow: 16 navigation sections, Action Flow Editor, AI features, code generation
- Bolt / v0 / Cursor / Replit / Windsurf: feature and positioning comparison

**Pricing architecture for enterprise:**
- Individual tier vs team tier vs enterprise tier
- 4-figure monthly business subscription is achievable at enterprise tier
- Needs clear differentiation between individual and enterprise capability sets

---

## 13. Two-Fork Distribution Model (planned)

- **Gerald's version**: his config hardcoded — personal production instance
- **Public skeleton**: stripped version for other users to configure their own agent stack

The public skeleton is the open-source / commercial release. Gerald's version is the internal production system.
