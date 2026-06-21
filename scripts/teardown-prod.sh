#!/usr/bin/env bash
# Stop the production Cortex v0.2 services and optionally wipe state.
#
# Usage:
#   scripts/teardown-prod.sh              # stop gateway + platform-backend
#   scripts/teardown-prod.sh --status     # report status without stopping
#   scripts/teardown-prod.sh --wipe-db    # stop + delete cortex.db
#   scripts/teardown-prod.sh --wipe       # stop + delete entire state dir (DANGER)
#
# Environment overrides (optional):
#   CORTEX_DATA_DIR         default: <repo>/data  (resolved relative to this script)
#   CORTEX_GATEWAY_PORT     default: 4840  (used as fallback port scan)
#   CORTEX_PLATFORM_PORT    default: 4830  (used as fallback port scan)

set -euo pipefail

_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_REBUILD_ROOT="$(cd "${_SCRIPT_DIR}/.." && pwd)"
DATA_DIR="${CORTEX_DATA_DIR:-${_REBUILD_ROOT}/data}"
GATEWAY_PORT="${CORTEX_GATEWAY_PORT:-4840}"
PLATFORM_PORT="${CORTEX_PLATFORM_PORT:-4830}"
STATE_DIR="$DATA_DIR/state"
GATEWAY_PID_FILE="$STATE_DIR/gateway.pid"
PLATFORM_PID_FILE="$STATE_DIR/platform.pid"

ACTION="stop"
for arg in "$@"; do
  case "$arg" in
    --wipe)    ACTION="wipe" ;;
    --wipe-db) ACTION="wipe-db" ;;
    --status)  ACTION="status" ;;
    -h|--help)
      sed -n '3,11p' "$0"
      exit 0
      ;;
    *)
      echo "teardown-prod.sh: unknown arg '$arg'" >&2
      exit 2
      ;;
  esac
done

# --- resolve a live PID from PID file or fallback port scan ------------------
resolve_pid() {
  local pid_file="$1"
  local port="$2"
  local label="$3"
  local pid=""

  if [[ -s "$pid_file" ]]; then
    local candidate
    candidate="$(cat "$pid_file")"
    if kill -0 "$candidate" 2>/dev/null; then
      pid="$candidate"
    fi
  fi

  # Fallback: find by listening port. Prefer lsof, then parse ss output.
  if [[ -z "$pid" ]] && command -v lsof >/dev/null 2>&1; then
    pid="$(lsof -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  fi

  if [[ -z "$pid" ]] && command -v ss >/dev/null 2>&1; then
    pid="$(ss --tcp --listening --numeric --processes 2>/dev/null \
      | python3 -c 'import re,sys; port=sys.argv[1];
for line in sys.stdin:
    if f":{port} " not in line:
        continue
    m=re.search(r"pid=(\\d+)", line)
    if m:
        print(m.group(1)); break' "$port")"
  fi

  echo "$pid"
}

# --- stop one process --------------------------------------------------------
stop_process() {
  local pid="$1"
  local label="$2"
  local pid_file="$3"

  if [[ -n "$pid" ]]; then
    echo "teardown-prod.sh: sending SIGTERM to $label (pid=$pid)"
    kill -TERM "$pid" 2>/dev/null || true
    for _ in 1 2 3; do
      if ! kill -0 "$pid" 2>/dev/null; then break; fi
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      echo "teardown-prod.sh: $label did not exit on SIGTERM — sending SIGKILL"
      kill -KILL "$pid" 2>/dev/null || true
    fi
    rm -f "$pid_file"
    echo "teardown-prod.sh: $label stopped"
  else
    echo "teardown-prod.sh: $label not found — nothing to stop"
    # pkill fallback so stale procs don't linger if PID file was missing.
    pkill --full "services/gateway/server.js"   2>/dev/null || true
    pkill --full "platform/backend/server.js"   2>/dev/null || true
  fi
}

GATEWAY_PID="$(resolve_pid "$GATEWAY_PID_FILE"  "$GATEWAY_PORT"  "gateway")"
PLATFORM_PID="$(resolve_pid "$PLATFORM_PID_FILE" "$PLATFORM_PORT" "platform-backend")"

# --- status only -------------------------------------------------------------
if [[ "$ACTION" == "status" ]]; then
  if [[ -n "$GATEWAY_PID" ]]; then
    echo "gateway:          RUNNING (pid=$GATEWAY_PID, port=$GATEWAY_PORT)"
  else
    echo "gateway:          NOT RUNNING"
  fi
  if [[ -n "$PLATFORM_PID" ]]; then
    echo "platform-backend: RUNNING (pid=$PLATFORM_PID, port=$PLATFORM_PORT)"
  else
    echo "platform-backend: NOT RUNNING"
  fi
  if [[ -d "$STATE_DIR" ]]; then
    echo "state dir: $STATE_DIR (present)"
    local_db="$STATE_DIR/cortex.db"
    if [[ -s "$local_db" ]]; then
      db_size="$(du -h "$local_db" | cut -f1)"
      echo "  db: $db_size"
    fi
  else
    echo "state dir: $STATE_DIR (absent)"
  fi
  exit 0
fi

# --- stop both processes (platform first — less harm if it exits early) ------
stop_process "$PLATFORM_PID" "platform-backend" "$PLATFORM_PID_FILE"
stop_process "$GATEWAY_PID"  "gateway"           "$GATEWAY_PID_FILE"

# --- optional state wipe -----------------------------------------------------
case "$ACTION" in
  wipe)
    if [[ -d "$STATE_DIR" ]]; then
      echo "teardown-prod.sh: wiping $STATE_DIR"
      rm --recursive --force "$STATE_DIR"
    else
      echo "teardown-prod.sh: state dir already absent"
    fi
    ;;
  wipe-db)
    DB="$STATE_DIR/cortex.db"
    if [[ -f "$DB" ]]; then
      echo "teardown-prod.sh: wiping $DB"
      rm --force "$DB" "${DB}-wal" "${DB}-shm"
    else
      echo "teardown-prod.sh: DB not found at $DB"
    fi
    ;;
esac
