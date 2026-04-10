# Cortex Architecture

Cortex is a local agent gateway that sits between an agent runtime and the work it performs.

## Main parts

- Frontend: dashboard UI for tasks, activity, bridge traffic, and runtime visibility
- Backend: thin platform server that serves the dashboard and proxies selected API requests
- Gateway: the main service on port `4840` that handles task state, MCP traffic, bridge operations, telemetry, and enforcement
- Workspace data: runtime state, projects, and task artifacts stored on disk

## How requests flow

1. An agent starts in a Cortex-aware workspace.
2. The agent connects to Cortex-backed MCP tooling.
3. Tool calls, task actions, and bridge events go through the gateway.
4. The gateway records task state and runtime activity.
5. The dashboard reads that state back out of the backend and gateway APIs.

## What Cortex is responsible for

- Agent identity and attribution
- Task and project lifecycle
- Bridge coordination between agents
- Runtime telemetry and logs
- Shared MCP tool routing

## What Cortex does not replace

Cortex does not replace the underlying agent runtime. Claude Code, Codex, Hermes, and other hosts still run the agent itself. Cortex wraps the operational surface around that runtime so work is easier to inspect, coordinate, and audit.

## Related note

There is also an older high-level note in [ARCHITECTURE.md](./ARCHITECTURE.md).
