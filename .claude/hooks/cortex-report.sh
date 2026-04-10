#!/usr/bin/env bash
set -uo pipefail

CORTEX="http://127.0.0.1:4840"
AGENT_NAME="${CORTEX_AGENT_ID:-atlas}"
CORTEX_HOME="${CORTEX_HOME:-$(cd "$(dirname "$0")/../.." && pwd)}"
ENV_FILE="${CORTEX_TOKEN_DIR:-$HOME/.cortex-vault/keys}/${AGENT_NAME}.env"
RUNTIME_DIR="${CORTEX_RUN_DIR:-$CORTEX_HOME/data/run}"

mkdir -p "$RUNTIME_DIR"
chmod 700 "$RUNTIME_DIR" 2>/dev/null || true

# PID-scoped task file lookup (matches gate logic)
find_task_file() {
  local ppid="$PPID"
  while [ "$ppid" -gt 1 ] 2>/dev/null; do
    [ -f "$RUNTIME_DIR/atlas-${ppid}-current-task" ] && echo "$RUNTIME_DIR/atlas-${ppid}-current-task" && return
    ppid=$(ps -o ppid= -p "$ppid" 2>/dev/null | tr -d ' ') || break
  done
  [ -f "$RUNTIME_DIR/atlas-current-task" ] && echo "$RUNTIME_DIR/atlas-current-task" && return
  echo ""
}
TASK_FILE=$(find_task_file)
[ -z "$TASK_FILE" ] && exit 0
TASK_ID=$(cat "$TASK_FILE" 2>/dev/null || echo "")
[ -z "$TASK_ID" ] && exit 0

TOKEN=$(grep CORTEX_AGENT_TOKEN "$ENV_FILE" 2>/dev/null | cut -d= -f2- || echo "")
cortex_curl() {
  [ -n "$TOKEN" ] || return 1
  curl --config <(printf '%s\n' "header = \"X-Cortex-Token: $TOKEN\"") "$@"
}
INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // .tool_input.command // "unknown"' 2>/dev/null || echo "unknown")

# --- Stub Detection ---
STUB_DETECTED="false"
STUB_REASON=""

if [[ "$TOOL_NAME" =~ ^(Write|Edit|NotebookEdit)$ ]]; then
  CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // .tool_input.new_string // ""' 2>/dev/null || echo "")

  if echo "$CONTENT" | grep -qE 'return\s*\{\s*(ok|success)\s*:\s*true\s*\}'; then
    if ! echo "$CONTENT" | grep -qE '(await|fetch|query|exec|spawn|readFile|writeFile|createHash)'; then
      STUB_DETECTED="true"
      STUB_REASON="Returns ok/success with no real implementation"
    fi
  fi

  if echo "$CONTENT" | grep -qiE '\b(TODO|FIXME|PLACEHOLDER|STUB|NOT_IMPLEMENTED|HACK)\b'; then
    STUB_DETECTED="true"
    STUB_REASON="Contains placeholder/stub markers"
  fi

  if echo "$CONTENT" | grep -qP '(function|async function|const \w+ = async)\s*\([^)]*\)\s*\{\s*\}'; then
    STUB_DETECTED="true"
    STUB_REASON="Empty function body"
  fi

  # Pattern: pass/noop implementations
  if echo "$CONTENT" | grep -qP 'function\s+\w+\([^)]*\)\s*\{\s*(return;?|pass)\s*\}'; then
    STUB_DETECTED="true"
    STUB_REASON="Noop/pass function implementation"
  fi

  # Pattern: return null/undefined with no logic
  if echo "$CONTENT" | grep -qP 'function\s+\w+\([^)]*\)\s*\{\s*return\s+(null|undefined|0|false|""|\{\})\s*;?\s*\}'; then
    STUB_DETECTED="true"
    STUB_REASON="Function returns trivial value with no logic"
  fi

  # Pattern: will finish later / not done yet comments
  if echo "$CONTENT" | grep -qiE '(will (finish|complete|implement|do) (later|this|soon)|not (done|finished|implemented) yet|come back to this|skip for now)'; then
    STUB_DETECTED="true"
    STUB_REASON="Contains deferred-work comments"
  fi

  # Pattern: console.log only implementation
  LINE_COUNT=$(echo "$CONTENT" | wc -l)
  LOG_COUNT=$(echo "$CONTENT" | grep -cE 'console\.(log|warn|info|error)' || echo 0)
  if [ "$LINE_COUNT" -lt 10 ] && [ "$LOG_COUNT" -gt 0 ]; then
    REAL_LINES=$(echo "$CONTENT" | grep -cvE '^\s*($|//|/\*|\*|console\.|\}|\{|import|export|function|async|const|let|var)' || echo 0)
    if [ "$REAL_LINES" -lt 2 ]; then
      STUB_DETECTED="true"
      STUB_REASON="Implementation is only console.log statements"
    fi
  fi
fi

if [ "$TOOL_NAME" = "Bash" ]; then
  OUTPUT=$(echo "$INPUT" | jq -r '.tool_output // ""' 2>/dev/null || echo "")

  if echo "$OUTPUT" | grep -qiE '(route\.fulfill|page\.route.*fulfill|intercept.*mock|mock.*response.*fake)'; then
    STUB_DETECTED="true"
    STUB_REASON="Test intercepts/mocks API responses"
  fi

  if echo "$OUTPUT" | grep -qE 'expect\(true\)\.toBe\(true\)|assert\.ok\(true\)|expect\(1\)\.toBe\(1\)'; then
    STUB_DETECTED="true"
    STUB_REASON="Test contains trivial always-passing assertions"
  fi
fi

# --- Report ---
PAYLOAD=$(jq -n \
  --arg agent "$AGENT_NAME" \
  --arg summary "$TOOL_NAME on $FILE_PATH" \
  --arg file "$FILE_PATH" \
  --argjson stub "$STUB_DETECTED" \
  --arg stub_reason "$STUB_REASON" \
  '{agent_id: $agent, status: "in_progress", summary: $summary, files_changed: [$file], stub_detected: $stub, stub_reason: $stub_reason}')

cortex_curl -sf --max-time 3 -X POST "$CORTEX/tasks/$TASK_ID/progress" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" > /dev/null 2>&1 || true

if [ "$STUB_DETECTED" = "true" ]; then
  echo "STUB/FAKE DETECTED: $STUB_REASON — File: $FILE_PATH" >&2
fi

# --- Token estimation from tool input/output size (ESTIMATE, not actual API billing) ---
# Opus averages ~1.3 chars/token for code, ~4 chars/token for prose. Using 2.5 as middle ground.
# Rates: Opus 4.6 $15/M input, $75/M output
INPUT_LEN=$(echo "$INPUT" | jq -r '.tool_input // "" | tostring | length' 2>/dev/null || echo 0)
OUTPUT_LEN=$(echo "$INPUT" | jq -r '.tool_output // "" | tostring | length' 2>/dev/null || echo 0)
EST_TOKENS_IN=$(( (INPUT_LEN * 10 + 24) / 25 ))
EST_TOKENS_OUT=$(( (OUTPUT_LEN * 10 + 24) / 25 ))
# Cost in USD: input $15/M, output $75/M
COST_USD=$(python3 -c "print(round($EST_TOKENS_IN * 15 / 1000000 + $EST_TOKENS_OUT * 75 / 1000000, 6))" 2>/dev/null || echo 0)

# --- Telemetry: log every tool call to gateway_logs ---
TELEMETRY=$(jq -n \
  --arg agent "$AGENT_NAME" \
  --arg method "$TOOL_NAME" \
  --arg endpoint "$FILE_PATH" \
  --arg task_id "$TASK_ID" \
  --argjson tokens_in "$EST_TOKENS_IN" \
  --argjson tokens_out "$EST_TOKENS_OUT" \
  --argjson cost "$COST_USD" \
  '{
    method: $method,
    endpoint: $endpoint,
    provider: "claude-code",
    model: "opus-4.6",
    project_id: $task_id,
    status_code: 200,
    tokens_in: $tokens_in,
    tokens_out: $tokens_out,
    cost_usd: $cost,
    latency_ms: 0
  }')

cortex_curl -sf --max-time 3 -X POST "$CORTEX/api/gateway/telemetry" \
  -H "Content-Type: application/json" \
  -d "$TELEMETRY" > /dev/null 2>&1 || true

# --- Subagent tracking: complete the event started by PreToolUse ---
if [ "$TOOL_NAME" = "Agent" ]; then
  SUBAGENT_DIR="$RUNTIME_DIR/subagents"
  NOW_MS=$(date +%s%3N)
  COMPLETED=false

  # Find the most recent unmatched start event and complete it
  if [ -d "$SUBAGENT_DIR" ]; then
    for f in "$SUBAGENT_DIR"/*; do
      [ -f "$f" ] || continue
      # Read original event_id from file content (not filename, which is sanitized)
      EVENT_ID=$(jq -r '.event_id // ""' "$f" 2>/dev/null || basename "$f")
      STARTED_AT=$(jq -r '.started_at // 0' "$f" 2>/dev/null || echo 0)
      DURATION_MS=$((NOW_MS - STARTED_AT))

      # Determine status from tool output
      TOOL_OUTPUT=$(echo "$INPUT" | jq -r '.tool_output // ""' 2>/dev/null || echo "")
      STATUS="completed"
      if echo "$TOOL_OUTPUT" | grep -qiE '(error|failed|exception)' 2>/dev/null; then
        STATUS="failed"
      fi

      # Extract a result summary (first 200 chars of output)
      RESULT_SUMMARY=$(echo "$TOOL_OUTPUT" | head -c 200)

      cortex_curl -sf --max-time 3 -X POST "$CORTEX/api/subagents/complete" \
        -H "Content-Type: application/json" \
        -d "$(jq -n \
          --arg eid "$EVENT_ID" \
          --arg status "$STATUS" \
          --argjson duration "$DURATION_MS" \
          --arg summary "$RESULT_SUMMARY" \
          '{event_id: $eid, status: $status, duration_ms: $duration, result_summary: $summary}')" \
        > /dev/null 2>&1 || true

      # Remove the tracking file
      rm -f "$f" 2>/dev/null
      COMPLETED=true
      break
    done
  fi

  # Fallback: if no start event found, create a completed event directly
  if [ "$COMPLETED" = "false" ]; then
    SUBAGENT_TYPE=$(echo "$INPUT" | jq -r '.tool_input.subagent_type // "general-purpose"' 2>/dev/null || echo "general-purpose")
    SUBAGENT_DESC=$(echo "$INPUT" | jq -r '.tool_input.description // ""' 2>/dev/null || echo "")
    cortex_curl -sf --max-time 3 -X POST "$CORTEX/api/subagents/event" \
      -H "Content-Type: application/json" \
      -d "$(jq -n \
        --arg parent "$AGENT_NAME" \
        --arg type "$SUBAGENT_TYPE" \
        --arg desc "$SUBAGENT_DESC" \
        --arg task "$TASK_ID" \
        '{parent_agent: $parent, subagent_type: $type, description: $desc, task_id: $task}')" \
      > /dev/null 2>&1 || true
  fi
fi

exit 0
