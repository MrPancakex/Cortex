#!/usr/bin/env bash
set -uo pipefail

CORTEX="http://127.0.0.1:4840"
AGENT_NAME="${CORTEX_AGENT_ID:-atlas}"
CORTEX_HOME="${CORTEX_HOME:-$(cd "$(dirname "$0")/../.." && pwd)}"
ENV_FILE="${CORTEX_TOKEN_DIR:-$HOME/.cortex-vault/keys}/${AGENT_NAME}.env"
RUNTIME_DIR="${CORTEX_RUN_DIR:-$CORTEX_HOME/data/run}"

TOKEN=$(grep CORTEX_AGENT_TOKEN "$ENV_FILE" 2>/dev/null | cut -d= -f2- || echo "")
cortex_curl() {
  [ -n "$TOKEN" ] || return 1
  curl --config <(printf '%s\n' "header = \"X-Cortex-Token: $TOKEN\"") "$@"
}

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
[ "$TOOL_NAME" != "Agent" ] && exit 0

SUBAGENT_TYPE=$(echo "$INPUT" | jq -r '.tool_input.subagent_type // "general-purpose"' 2>/dev/null || echo "general-purpose")
DESCRIPTION=$(echo "$INPUT" | jq -r '.tool_input.description // ""' 2>/dev/null || echo "")
TASK_ID=""

# Read active task from task file
for f in "$RUNTIME_DIR/$AGENT_NAME"-*-current-task "$RUNTIME_DIR/$AGENT_NAME-current-task"; do
  [ -f "$f" ] && TASK_ID=$(cat "$f" 2>/dev/null | tr -d '[:space:]') && break
done

# Register subagent start with gateway — capture event_id for completion tracking
RESULT=$(cortex_curl -sf --max-time 3 -X POST "$CORTEX/api/subagents/event" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg parent "$AGENT_NAME" \
    --arg type "$SUBAGENT_TYPE" \
    --arg desc "$DESCRIPTION" \
    --arg task "$TASK_ID" \
    '{parent_agent: $parent, subagent_type: $type, description: $desc, task_id: $task}')" 2>/dev/null || echo "")

EVENT_ID=$(echo "$RESULT" | jq -r '.event_id // ""' 2>/dev/null || echo "")

# Sanitize event_id — strip path traversal characters, only allow UUID chars
SAFE_ID=$(echo "$EVENT_ID" | tr -cd 'a-zA-Z0-9_-')

# Store event_id and start time for the PostToolUse hook to read
if [ -n "$SAFE_ID" ]; then
  mkdir -p "$RUNTIME_DIR/subagents"
  echo "{\"event_id\":\"$EVENT_ID\",\"started_at\":$(date +%s%3N),\"type\":\"$SUBAGENT_TYPE\",\"description\":\"$DESCRIPTION\"}" \
    > "$RUNTIME_DIR/subagents/$SAFE_ID" 2>/dev/null || true
fi

exit 0
