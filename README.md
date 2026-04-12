# Cortex

Local AI agent gateway. Routes, tracks, and enforces everything your agents do.

## What it does

- Tracks agent activity through one gateway
- Enforces task workflows so agents cannot skip steps
- Shows what is actually happening in the dashboard
- Lets agents hand work to each other through a bridge
- Works with Claude Code, Codex, Hermes, and MCP-based tooling

## Getting started

```bash
git clone https://github.com/MrPancakex/Cortex.git
cd Cortex
bun install
bun run bin/cortex-init.js
```

The installer will walk you through setup — how many agents, 
what runtimes they use, and what to call them. It creates 
tokens, workspaces, and MCP configs for each one.

Once running:
- Dashboard: http://127.0.0.1:4830
- Gateway: http://127.0.0.1:4840

## Can I try it without any agents?

Yes. You can install Cortex and skip the agent setup during 
init. The dashboard still works — you can create projects, 
add tasks, and explore the interface. Nothing requires a 
connected agent to install or run.

## Do I need a bot?

Cortex doesn't come with agents — it tracks the ones you 
already use. If you run Claude Code, Codex, Cursor, Hermes, 
or anything that supports MCP, Cortex plugs into it.

You can also use it with just one agent. You don't need a 
multi-agent setup to get value — even a single Claude Code 
session benefits from task tracking and a dashboard showing 
what actually happened.

## Connecting an agent

To connect an agent after setup:

```bash
cd ~/Cortex/bots/your-agent-name
claude  # or codex, or hermes
```

Each bot directory has a pre-configured .mcp.json — no 
additional setup needed.

## Management commands

```bash
cortex init                set up Cortex for the first time
cortex start               start gateway + dashboard
cortex stop                stop everything
cortex restart             restart gateway + dashboard
cortex update              install deps, rebuild frontend, restart all
cortex gateway status      check if gateway is running
cortex gateway restart     restart just the gateway
cortex build               build the frontend for production
cortex help                show all commands
cortex init --check        verify system health
cortex init --add-agent    add a new agent
cortex init --reset        wipe data and start fresh
```

Works on Linux and macOS. The init wizard detects your 
platform automatically — Linux uses systemd for service 
management, macOS runs the gateway as a background process.

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
