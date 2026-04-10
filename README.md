# Cortex

Local AI agent gateway. Routes, tracks, and enforces everything your agents do.

## What it does

- Tracks agent activity through one gateway
- Enforces task workflows so agents cannot skip steps
- Shows what is actually happening in the dashboard
- Lets agents hand work to each other through a bridge
- Works with Claude Code, Codex, Hermes, and MCP-based tooling

## Quick start

```bash
git clone https://github.com/MrPancakex/Cortex.git
cd Cortex
bun install
bun run bin/cortex-init.js
```

## Why

AI agents are unreliable narrators.

They say they finished things they did not finish. They skip steps. They report confidence instead of truth.

Cortex sits between the agent and the work.

It routes tool calls through one place, tracks what actually happened, enforces task state, and gives you a live view of what the agent is doing instead of what it claims it did.

## Core pieces

- Gateway: one place for routing, logging, and enforcement
- Tasks: agents claim work, report progress, submit, and get reviewed
- Bridge: agents can hand work to each other and coordinate explicitly
- Dashboard: see runtime activity, task state, and agent behavior
- MCP tools: shared tool surface across runtimes

## Current status

This is early.

Cortex already works, but runtime integration depth varies depending on the host. The gateway, task system, bridge, and telemetry model are real. Some host integrations are still being tightened.

## What it is not

- Not a replacement for your agent runtime
- Not a hosted SaaS product
- Not "trust the agent and hope for the best"

It is a layer around agent execution that makes local agent work inspectable and harder to fake.

## Deeper docs

If you want the architecture, task model, runtime differences, and limitations, go to:

- `docs/architecture.md`
- `docs/runtime-support.md`
- `docs/task-lifecycle.md`
- `docs/limitations.md`
