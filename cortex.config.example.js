/**
 * Cortex Ecosystem Config — declarative process configuration example.
 * Copy to `cortex.config.js` and customise for your setup.
 *
 * Environment variables always win over values set here. The full list
 * of live `CORTEX_*` env vars is documented at the bottom of this file;
 * each commented entry shows the default that the gateway falls back to
 * when the variable is unset.
 *
 * Phase 6 Task 6.5: agent process-supervision fields (maxRestarts,
 * initialBackoffMs, mergeLogs, etc.) were removed from this example
 * because the `ecosystem-loader.js` that consumed them was never wired
 * into the runtime launcher. Agent supervision is tracked in
 * docs/roadmap.md as a v0.3 feature.
 */
export default {
  gateway: {
    port: 4840,
    host: '127.0.0.1',
    db: './data/gateway.db',
    tokenRegistry: './data/token-registry.json',
    logMaxSizeMb: 10,      // per-agent log file size before rotation
    logMaxFiles: 5,         // rotated copies to keep
    drainTimeoutMs: 8_000,  // graceful shutdown drain timeout
  },

  agents: [
    {
      name: 'nova',
      script: 'services/gateway/mcp/stdio.js',
      platform: 'claude-code',
      env: {
        CORTEX_AGENT_ID: 'nova',
        CORTEX_AGENT_PLATFORM: 'claude-code',
      },
    },
    {
      name: 'orion',
      script: 'services/gateway/mcp/stdio.js',
      platform: 'claude-code',
      env: {
        CORTEX_AGENT_ID: 'orion',
        CORTEX_AGENT_PLATFORM: 'claude-code',
      },
    },
  ],
};

/*
  Live CORTEX_* environment variables (Phase 6 Task 6.7 sync).
  Set these in the shell that starts the gateway / agent processes.

  ── Gateway bind + storage ────────────────────────────────────────────
  CORTEX_GATEWAY_PORT       = 4840                 # default 4840
  CORTEX_GATEWAY_HOST       = 127.0.0.1            # loopback-only by default
  CORTEX_GATEWAY_DB         = ./data/gateway.db    # SQLite path
  CORTEX_GATEWAY_URL        = http://127.0.0.1:4840
  CORTEX_TOKEN_REGISTRY     = ./data/token-registry.json
  CORTEX_HOME               = /path/to/Cortex      # repo root
  CORTEX_DATA_DIR           = ./data               # general data directory
  CORTEX_HUB_DIR            = ./data/hub           # cross-agent scratch
  CORTEX_RUN_DIR            = ./data/run           # pidfiles / lease files
  CORTEX_LOG_DIR            = ./logs/agents
  CORTEX_LOG_MAX_SIZE_MB    = 10
  CORTEX_LOG_MAX_FILES      = 5
  CORTEX_LOG_RECOVERY_PATH  = ./data/log-recovery.jsonl
  CORTEX_PROJECTS_DIR       = ./data/projects
  CORTEX_AGENTS_DIR         = ./bots
  CORTEX_WORKSPACE          = ./workspace
  CORTEX_DRAIN_TIMEOUT_MS   = 8000

  ── Mode + network trust boundary ─────────────────────────────────────
  CORTEX_MODE               = standard             # or 'hardened' to enforce loopback bind
  CORTEX_CORS_ORIGIN        =                      # empty = same-origin only
  CORTEX_TRUSTED_PROXIES    =                      # comma-sep IPs allowed to send X-Forwarded-For
  CORTEX_MAX_BODY_BYTES     = 1048576              # 1 MB HTTP body cap
  CORTEX_MAX_WS_PER_AGENT   = 10                   # concurrent WebSockets per agent

  ── Rate limits ───────────────────────────────────────────────────────
  CORTEX_RATE_AUTH_FAIL     = 20                   # auth failures per IP per minute
  CORTEX_RATE_AGENT_REQ     = 600                  # authenticated reqs per agent per minute
  CORTEX_PROGRESS_RATE_LIMIT= 60                   # report_progress/min/agent

  ── MCP session caps ──────────────────────────────────────────────────
  CORTEX_MCP_MAX_SESSIONS   = 100
  CORTEX_MCP_SESSION_TTL_MS = 3600000              # 1h

  ── Agent identity (usually set by launcher, not operator) ───────────
  CORTEX_AGENT_ID           = <your-agent-id>
  CORTEX_AGENT_PLATFORM     = claude-code
  CORTEX_AGENT_TOKEN        =                      # hashed against token-registry
  CORTEX_AGENT_TOKEN_FILE   = ~/.cortex/token      # read if AGENT_TOKEN unset
  CORTEX_TOKEN_FILE         =                      # alias (tests)
  CORTEX_TOKEN_DIR          =
  CORTEX_CURRENT_TASK_FILE  = ./data/run/<agent>-current-task
  CORTEX_API                = http://127.0.0.1:4840

  ── Reviewer flywheel ────────────────────────────────────────────────
  CORTEX_ZEUS_REVIEWER_ENABLED          = 0        # set to '1' to enable
  CORTEX_ZEUS_REVIEWER_AGENT            = <reviewer-agent-id>
  CORTEX_CODEX_COMMAND                  = codex    # binary name or path
  CORTEX_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS = 30000
  CORTEX_CODEX_REVIEW_STALE_RUN_MS      = 900000

  ── Channel plugin / session plumbing ─────────────────────────────────
  CORTEX_WATCHER_CONFIG            = ./data/watcher-config.json
  CORTEX_CHANNEL_POINTER_TIMEOUT_MS= 5000
  CORTEX_OWNED_LAUNCH              =               # '1' when launched by the gateway
  CORTEX_FORCE_NO_PROC             =               # test-only; skip /proc reads

  ── Test-only harness knobs ───────────────────────────────────────────
  CORTEX_TEST_ANTHROPIC_MODEL  = claude-sonnet-4
  CORTEX_TEST_OPENAI_MODEL     = gpt-4o-mini
  CORTEX_TEST_OPENROUTER_MODEL = anthropic/claude-sonnet-4
  CORTEX_TEST_OLLAMA_MODEL     = llama3
*/
