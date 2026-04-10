#!/usr/bin/env bash
CORTEX="http://127.0.0.1:4840"
AGENT_NAME="${CORTEX_AGENT_ID:-atlas}"
CORTEX_HOME="${CORTEX_HOME:-$(cd "$(dirname "$0")/../.." && pwd)}"
ENV_FILE="${CORTEX_TOKEN_DIR:-$HOME/.cortex-vault/keys}/${AGENT_NAME}.env"
RUNTIME_DIR="${CORTEX_RUN_DIR:-$CORTEX_HOME/data/run}"

mkdir -p "$RUNTIME_DIR"
chmod 700 "$RUNTIME_DIR" 2>/dev/null || true
TOKEN=$(grep CORTEX_AGENT_TOKEN "$ENV_FILE" 2>/dev/null | cut -d= -f2- || echo "")
cortex_curl() {
  [ -n "$TOKEN" ] || return 1
  curl --config <(printf '%s\n' "header = \"X-Cortex-Token: $TOKEN\"") "$@"
}

cortex_curl -sf --max-time 2 -X POST "$CORTEX/api/agents/heartbeat" \
  -H "Content-Type: application/json" \
  -d "{\"agent_id\":\"$AGENT_NAME\",\"task_id\":null,\"status\":\"idle\"}" > /dev/null 2>&1 || true

# Clean up task and project files — exact patterns only, no wildcards
rm -f "$RUNTIME_DIR/${AGENT_NAME}-current-task" 2>/dev/null
rm -f "$RUNTIME_DIR/${AGENT_NAME}-active-project" 2>/dev/null
# Clean subagent tracking files
rm -rf "$RUNTIME_DIR/subagents" 2>/dev/null
exit 0
