# Limitations

This is still early software.

## Current limitations

- Runtime integration depth varies by host
- Some host-native actions are easier to track than others
- Sub-agent visibility depends on how the host exposes sub-agent lifecycle
- Gateway-backed execution is stronger than direct local execution
- Some enforcement paths are workflow-based rather than hard-blocked

## Important distinction

Cortex can reliably track and control the work that passes through Cortex.

It cannot automatically make every host-native behavior identical unless that host exposes the right integration points.

## What not to overclaim

- Do not claim all runtimes have the same enforcement depth
- Do not claim every sub-agent action is auto-captured in every host
- Do not claim Cortex replaces the underlying runtime

## What is already real

- Gateway-routed tooling
- Task lifecycle enforcement
- Bridge messaging
- Runtime logging for Cortex-routed activity
- Agent identity and attribution

## The honest framing

Cortex already works as a shared gateway and orchestration layer for local agents. The remaining work is mostly about tightening host-specific integrations, not inventing the core system.
