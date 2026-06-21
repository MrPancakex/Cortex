# Cortex — Agent Onboarding Prompt

Hand this file to any MCP-capable agent. It ties **itself** into your Cortex
instance: adds the gateway as an MCP server, registers an identity, claims its
first task, and runs the work loop. Cortex is model-agnostic — there is no
per-model wiring to generate; everything below is neutral.

> Replace `<AGENT_ID>` with the agent name you minted (`cortex init` /
> `cortex init --add-agent` printed it). The token lives in
> `~/.cortex/keys/<AGENT_ID>.env` as `CORTEX_AGENT_TOKEN=...`.

## Connection facts

- Gateway HTTP API: `http://127.0.0.1:4840`
- MCP transport: stdio
- MCP command: `bun <repo>/services/gateway/mcp/stdio.js`
- Token file: `~/.cortex/keys/<AGENT_ID>.env`

## Step 1 — Add the Cortex MCP server (your runtime's own format)

Configure your runtime to launch the stdio MCP server with the agent identity
and token directory in the environment. The shape (your runtime decides the
exact file/keys):

    command: bun
    args:    ["<repo>/services/gateway/mcp/stdio.js"]
    env:
      CORTEX_API:       http://127.0.0.1:4840
      CORTEX_AGENT_ID:  <AGENT_ID>
      CORTEX_TOKEN_DIR: ~/.cortex/keys

## Step 2 — Register your identity

Call the `agent_register` MCP tool (requires the admin token; `cortex init`
minted `~/.cortex/keys/admin.env`):

    agent_register { "name": "<AGENT_ID>", "platform": "<your-runtime>" }

## Step 3 — Claim your first task and run the loop

1. `get_next_task` (or `claim_task` for a specific id) — pick up work.
2. `report_progress` — journal as you go.
3. `submit_result` — finish the unit.
4. Repeat.

## Fallback — non-MCP / weak agents (raw HTTP API)

If your runtime cannot speak MCP, drive the same gateway over HTTP. Auth header
is `X-Cortex-Token: <your token>` (the value of `CORTEX_AGENT_TOKEN` in your
token file).

    # register (admin token)
    curl -s http://127.0.0.1:4840/v1/api/agents/register \
      -H 'Content-Type: application/json' \
      -H "X-Cortex-Token: $ADMIN_TOKEN" \
      -d '{"name":"<AGENT_ID>","platform":"<your-runtime>"}'

    # claim + report + submit follow the same /v1/api/* surface; see the
    # full walkthrough (docs/walkthrough.md) for the per-call payloads.

## Next

The full "run your own agent loop" walkthrough — server-side RBAC, the
folders-as-truth ledger, the durable event substrate — is in
`docs/walkthrough.md`.
