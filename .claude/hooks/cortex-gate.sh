#!/usr/bin/env bash
set -euo pipefail

CORTEX="http://127.0.0.1:4840"
AGENT_NAME="${CORTEX_AGENT_ID:-atlas}"
CORTEX_HOME="${CORTEX_HOME:-$(cd "$(dirname "$0")/../.." && pwd)}"
ENV_FILE="${CORTEX_TOKEN_DIR:-$HOME/.cortex-vault/keys}/${AGENT_NAME}.env"
RUNTIME_DIR="${CORTEX_RUN_DIR:-$CORTEX_HOME/data/run}"
PROJECT_FILE="$RUNTIME_DIR/${AGENT_NAME}-active-project"
CORTEXHUB="$CORTEX_HOME"

TOKEN=$(grep CORTEX_AGENT_TOKEN "$ENV_FILE" 2>/dev/null | cut -d= -f2- || echo "")
cortex_curl() {
  [ -n "$TOKEN" ] || return 1
  curl --config <(printf '%s\n' "header = \"X-Cortex-Token: $TOKEN\"") "$@"
}

INPUT=$(cat)
if ! echo "$INPUT" | jq empty 2>/dev/null; then
  echo '{"decision":"block","reason":"BLOCKED: Invalid JSON input"}'
  exit 2
fi

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""')
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // .tool_input.command // ""')

# --- Telemetry helper ---
log_gate() {
  local status_code="$1"
  local error_text="${2:-}"
  local project_id=""
  [ -f "$PROJECT_FILE" ] && project_id=$(cat "$PROJECT_FILE" 2>/dev/null || echo "")
  cortex_curl -sf --max-time 2 -X POST "$CORTEX/api/gateway/telemetry" \
    -H "Content-Type: application/json" \
    -d "$(jq -n \
      --arg method "GATE:$TOOL_NAME" \
      --arg endpoint "$FILE_PATH" \
      --arg project_id "$project_id" \
      --argjson status "$status_code" \
      --arg error "$error_text" \
      '{method:$method, endpoint:$endpoint, provider:"claude-code", model:"opus-4.6", project_id:$project_id, status_code:$status, error:$error, tokens_in:0, tokens_out:0, cost_usd:0, latency_ms:0}')" \
    > /dev/null 2>&1 || true
}

# ═══ 1. ALWAYS ALLOW — no checks needed ═══

# Read-only tools
case "$TOOL_NAME" in
  Read|Grep|Glob|Agent|WebFetch|WebSearch|LS|List) exit 0 ;;
esac

# All MCP tool calls
case "$TOOL_NAME" in
  mcp__*) exit 0 ;;
esac

# Bash: read-only and internal commands
if [ "$TOOL_NAME" = "Bash" ]; then
  # Collapse newlines to spaces to prevent multiline bypass of grep patterns
  CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""' | tr '\n' ' ')

  # Internal curl to Cortex gateway — always allowed
  if echo "$CMD" | grep -qP 'curl\s.*127\.0\.0\.1:4840|curl\s.*localhost:4840' 2>/dev/null; then
    exit 0
  fi

  # Git read operations — always allowed
  if echo "$CMD" | grep -qP '^\s*git\s+(status|log|diff|show|branch|stash|remote|blame)\b' 2>/dev/null; then
    exit 0
  fi

  # Pure read-only commands — allowed ONLY if no write sinks present
  if echo "$CMD" | grep -qP '^\s*(ls|cat|head|tail|echo|printf|wc|file|stat|du|df|find|which|type|env|id|whoami|hostname|uname|date|uptime|free|ps|ss|grep|rg|sort|uniq|cut|tr|less|more|realpath|basename|dirname|pwd|jq)\b' 2>/dev/null; then
    # Block if command has redirects, pipes to write sinks, or command chaining
    if ! echo "$CMD" | grep -qP '(>\s|>>\s|\|\s*tee\b|;\s|&&\s|\|\|\s)' 2>/dev/null; then
      exit 0
    fi
    # Falls through to project check if write sinks detected
  fi
fi

# ═══ 2. CHECK PROJECT FILE ═══

if [ ! -f "$PROJECT_FILE" ]; then
  log_gate 403 "No active project"
  echo '{"decision":"block","reason":"BLOCKED: No active project. Call project_connect first."}'
  exit 2
fi

PROJECT_ID=$(cat "$PROJECT_FILE" 2>/dev/null || echo "")
if [ -z "$PROJECT_ID" ]; then
  log_gate 403 "Project file empty"
  echo '{"decision":"block","reason":"BLOCKED: Project file is empty. Call project_connect first."}'
  exit 2
fi

# ═══ 3. ALLOW WITHIN SCOPE ═══

if [ "$TOOL_NAME" = "Bash" ]; then
  CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""' | tr '\n' ' ')

  # Block dangerous commands regardless of scope
  if echo "$CMD" | grep -qP '(\bsudo\b|\brm\s+-rf\s+/)' 2>/dev/null; then
    log_gate 403 "Dangerous command blocked"
    echo '{"decision":"block","reason":"BLOCKED: Dangerous command blocked by Cortex."}'
    exit 2
  fi

  # Block all external network tools (only internal 127.0.0.1/localhost allowed)
  if echo "$CMD" | grep -qiP '\b(curl|wget|python.*https?://|python.*requests?\.|nc\s|ncat\s|netcat\s|socat\s)\b' 2>/dev/null; then
    if ! echo "$CMD" | grep -qP '127\.0\.0\.1|localhost' 2>/dev/null; then
      log_gate 403 "External network access blocked"
      echo '{"decision":"block","reason":"BLOCKED: External network access not allowed. Only 127.0.0.1/localhost permitted."}'
      exit 2
    fi
  fi

  # Block writes to protected paths
  if echo "$CMD" | grep -qP '(>\s|>>\s|\btee\b|\bsed\s+-i|\bchmod\b|\bchown\b|\bmkdir\b|\btouch\b|\bcp\b|\bmv\b|\brm\b)' 2>/dev/null; then
    # Check if the command targets protected dirs
    if echo "$CMD" | grep -qP '\b(/etc/|/opt/|systemd|/run/cortex/)' 2>/dev/null; then
      log_gate 403 "Write to protected path"
      echo '{"decision":"block","reason":"BLOCKED: Cannot write to protected system paths."}'
      exit 2
    fi
  fi

  # Git write operations (add, commit, push) — allow
  if echo "$CMD" | grep -qP '^\s*git\s+(add|commit|push|checkout|merge|rebase|reset|tag)\b' 2>/dev/null; then
    log_gate 200 ""
    exit 0
  fi

  # npm/bun install/test/build — allow
  if echo "$CMD" | grep -qP '^\s*(npm|bun|npx|yarn|pnpm)\s+(install|test|build|run|start|dev|lint|format|ci)\b' 2>/dev/null; then
    log_gate 200 ""
    exit 0
  fi

  # /tmp reads allowed, /tmp writes fall through to general allow (no blanket /tmp write pass)
  # This prevents symlink escape: agent creates symlink in /tmp pointing outside scope

  # For other bash commands with write sinks, fall through to path check below
fi

# Write/Edit/NotebookEdit — path enforcement
if [[ "$TOOL_NAME" =~ ^(Write|Edit|NotebookEdit)$ ]] && [[ -n "$FILE_PATH" ]]; then
  # Resolve the real path — use -f (follow symlinks) not -m (virtual)
  REAL_PATH=$(realpath -f "$FILE_PATH" 2>/dev/null || realpath -m "$FILE_PATH" 2>/dev/null || echo "$FILE_PATH")

  # Symlink check — resolve target and verify it's in scope
  if [ -L "$FILE_PATH" ]; then
    LINK_TARGET=$(readlink -f "$FILE_PATH" 2>/dev/null || echo "$FILE_PATH")
    if [[ "$LINK_TARGET" != "$CORTEXHUB"/* ]]; then
      log_gate 403 "Symlink target outside scope"
      echo '{"decision":"block","reason":"BLOCKED: Symlink target outside allowed scope."}'
      exit 2
    fi
  fi

  # Allow writes only under Cortex workspace
  if [[ "$REAL_PATH" == "$CORTEXHUB"/* ]]; then
    log_gate 200 ""
    exit 0
  fi

  # ═══ 4. BLOCK EVERYTHING ELSE ═══
  log_gate 403 "Write outside scope"
  echo '{"decision":"block","reason":"BLOCKED: Cannot write outside ~/Cortex/. Connected project: '"$PROJECT_ID"'"}'
  exit 2
fi

# --- Heartbeat ---
cortex_curl -sf --max-time 2 -X POST "$CORTEX/api/agents/heartbeat" \
  -H "Content-Type: application/json" \
  -d "{\"agent_id\":\"$AGENT_NAME\"}" > /dev/null 2>&1 || true

log_gate 200 ""
exit 0
