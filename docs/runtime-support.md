# Runtime Support

Cortex is built to work across multiple agent hosts, but not every host exposes the same control surface.

## Current model

- Claude Code: strongest integration surface because it exposes hook-based workflow controls
- Codex: solid MCP integration and task/telemetry routing, but some host-native behaviors need explicit workflow wrapping
- Hermes: supported through the shared Cortex model, with runtime depth depending on the host configuration

## What stays consistent across runtimes

- Cortex identity
- Task lifecycle
- Bridge messaging
- Project and context APIs
- MCP-backed tool routing
- Dashboard visibility for Cortex-routed actions

## Where runtimes differ

- How much pre-execution enforcement is possible
- How deeply native runtime events can be observed
- Whether sub-agent lifecycle can be intercepted automatically
- How much host configuration is needed to make Cortex the primary tool surface

## Practical rule

If an action goes through Cortex, it can be tracked consistently.

If an action stays inside the host runtime and never crosses the Cortex surface, tracking depth depends on what that host exposes.

## What this means in practice

For early releases, Cortex should be described as a shared gateway and orchestration layer across runtimes, not as proof that every host has identical enforcement depth.
