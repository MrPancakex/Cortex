#!/usr/bin/env bash
# Production launcher for Cortex v0.2 — gateway + platform-backend.
#
# Starts both services against the legacy data directory so production
# state (DB, token-registry, sessions) is preserved across the v1→v2
# cutover. Gateway must be alive before the platform proxy can route
# requests, hence the 1-second sleep between starts.
#
# Usage:
#   scripts/run-prod.sh              # boot with defaults
#   scripts/run-prod.sh --no-seed    # skip token-registry bootstrap
#   scripts/run-prod.sh --force-seed # regenerate admin token even if one exists
#
# Environment overrides (all optional):
#   CORTEX_DATA_DIR         default: <repo>/data
#   CORTEX_GATEWAY_PORT     default: 4840
#   CORTEX_PLATFORM_PORT    default: 4830
#   CORTEX_RBAC_DISABLED    default: 0 (set 1/true/yes/on to make /auth/check allow all)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REBUILD_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# --- defaults ----------------------------------------------------------------
DATA_DIR="${CORTEX_DATA_DIR:-$REBUILD_ROOT/data}"
GATEWAY_PORT="${CORTEX_GATEWAY_PORT:-4840}"
PLATFORM_PORT="${CORTEX_PLATFORM_PORT:-4830}"

# --- flag parsing ------------------------------------------------------------
SEED=1
FORCE_SEED=0
for arg in "$@"; do
  case "$arg" in
    --no-seed)    SEED=0 ;;
    --force-seed) FORCE_SEED=1 ;;
    -h|--help)
      sed -n '3,17p' "$0"
      exit 0
      ;;
    *)
      echo "run-prod.sh: unknown arg '$arg'" >&2
      exit 2
      ;;
  esac
done

# --- port conflict check -----------------------------------------------------
check_port() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    if ss --tcp --listening --numeric --processes 2>/dev/null | grep -q ":${port} "; then
      return 0   # port is bound
    fi
  elif command -v lsof >/dev/null 2>&1; then
    if lsof -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
      return 0   # port is bound
    fi
  fi
  return 1   # port is free
}

for port in "$GATEWAY_PORT" "$PLATFORM_PORT"; do
  if check_port "$port"; then
    echo "run-prod.sh: port $port is already in use." >&2
    echo "  Free it or set CORTEX_GATEWAY_PORT / CORTEX_PLATFORM_PORT to another port." >&2
    exit 1
  fi
done

# --- state dir + token registry ----------------------------------------------
STATE_DIR="$DATA_DIR/state"
LOG_DIR="$DATA_DIR/logs"
DB_PATH="$STATE_DIR/cortex.db"
REGISTRY_FILE="$STATE_DIR/token-registry.json"
ADMIN_TOKEN_FILE="$STATE_DIR/admin.token"
GATEWAY_PID_FILE="$STATE_DIR/gateway.pid"
PLATFORM_PID_FILE="$STATE_DIR/platform.pid"

mkdir -p "$STATE_DIR" "$LOG_DIR"
chmod 700 "$STATE_DIR"

# Export the path-resolution env BEFORE the seed block below, so rotateIdentity()
# (and the gateway) resolve identity/registry into $STATE_DIR (data/state) rather
# than the CORTEX_HOME fallback. Without this a fresh boot seeds identity outside
# data/state and signToken can't find it → dashboard login dead (B2 state-root desync).
export CORTEX_DATA_DIR="$DATA_DIR"
export CORTEX_STATE_ROOT="$STATE_DIR"

# Optional persisted runtime toggles written by operator helper scripts.
# Supported today:
#   CORTEX_RBAC_DISABLED=1|0   — bypass /auth/check (dev/repair only)
#   CORTEX_FOLDER_AUTHORITY=1  — enables the D2 manual-trigger admin endpoint
#                                (POST /v1/api/tasks/reconcile, Unix-socket only)
#                                and declares folder authority. Boot reconcile
#                                (scanAll) is unconditional existing behavior —
#                                the flag does NOT activate or suppress it.
#                                To activate: echo 'CORTEX_FOLDER_AUTHORITY=1' >>
#                                "$STATE_DIR/runtime.env" and restart the gateway.
#                                This file is parsed by scripts/lib/runtime-env.sh
#                                (strict allowlist — both keys must be listed there).
#
# SECURITY (Task-90 #1/#8): the default path lives under $STATE_DIR (700,
# operator-only), NOT the group-writable $DATA_DIR — a shared-group process must
# not be able to inject toggles. And we DO NOT `source` it: a strict allowlist
# parser (scripts/lib/runtime-env.sh) accepts only KEY=value for a fixed toggle
# set, so a tampered file can't run arbitrary shell.
RUNTIME_ENV_FILE="${CORTEX_RUNTIME_ENV_FILE:-$STATE_DIR/runtime.env}"
# shellcheck source=lib/runtime-env.sh disable=SC1091
source "${SCRIPT_DIR}/lib/runtime-env.sh"
parse_runtime_env "$RUNTIME_ENV_FILE"

if [[ "$SEED" == "1" ]]; then
  if [[ "$FORCE_SEED" == "1" || ! -s "$REGISTRY_FILE" ]]; then
    ADMIN_TOKEN="$(openssl rand -hex 32)"
    ADMIN_HASH="$(printf '%s' "$ADMIN_TOKEN" | sha256sum | cut -d' ' -f1)"
    cat > "$REGISTRY_FILE" <<JSON
{
  "agents": {
    "root": {
      "hash": "$ADMIN_HASH",
      "role": "admin",
      "base": "root"
    }
  }
}
JSON
    chmod 600 "$REGISTRY_FILE"
    printf '%s' "$ADMIN_TOKEN" > "$ADMIN_TOKEN_FILE"
    chmod 600 "$ADMIN_TOKEN_FILE"
    echo "run-prod.sh: seeded new admin token."
    echo "  token-registry: $REGISTRY_FILE"
    echo "  admin.token:    $ADMIN_TOKEN_FILE"
    echo "  ADMIN_TOKEN=$ADMIN_TOKEN"
  else
    echo "run-prod.sh: existing token-registry.json kept (pass --force-seed to regenerate)."
  fi

  # identity.json — HMAC secret for cookie-minting. Required by the
  # platform backend's auth bridge (sdk/auth/verify.js signToken).
  # Idempotent: rotateIdentity() writes a new file only if missing.
  IDENTITY_FILE="$STATE_DIR/identity.json"
  if [[ "$FORCE_SEED" == "1" || ! -s "$IDENTITY_FILE" ]]; then
    bun -e "
      import('$REBUILD_ROOT/sdk/auth/identity.js').then(m => {
        const next = m.rotateIdentity();
        console.log('run-prod.sh: identity seeded id=' + next.id);
      }).catch(e => { console.error('identity seed failed:', e.message); process.exit(1); });
    "
  else
    echo "run-prod.sh: existing identity.json kept."
  fi
fi

# --- clean up stale PID files ------------------------------------------------
rm -f "$GATEWAY_PID_FILE" "$PLATFORM_PID_FILE"

# --- export shared env -------------------------------------------------------
# CORTEX_HOME / CORTEX_DATA_DIR / CORTEX_RUN_DIR are exported so child
# processes (notably plugin subprocesses spawned by the supervisor) resolve
# the same paths as the gateway itself. Without these, defaultRunDir() falls
# back to $HOME/data/run which doesn't match where the MCP stdio bootstrap
# writes session pointer files (~/Cortex/data/run).
export CORTEX_DB_PATH="$DB_PATH"
export CORTEX_TOKEN_REGISTRY="$REGISTRY_FILE"
export CORTEX_HOME="$(dirname "$DATA_DIR")"
# Canonical projects root = top-level <CORTEX_HOME>/projects (operator decision
# 2026-06-05; data/projects move deferred to a future cutover). resolveProjectsRoot()
# returns $CORTEX_HUB_DIR/projects when launchers pin the hub.
export CORTEX_HUB_DIR="$CORTEX_HOME"
export CORTEX_RUN_DIR="$DATA_DIR/run"
export CORTEX_ADMIN_SOCKET="$STATE_DIR/admin.sock"
# CORTEX_DATA_DIR + CORTEX_STATE_ROOT are exported above, before the seed block.
export CORTEX_GATEWAY_HOST="127.0.0.1"
export CORTEX_GATEWAY_PORT="$GATEWAY_PORT"
export CORTEX_PLATFORM_PORT="$PLATFORM_PORT"
export PLATFORM_HOST="127.0.0.1"
export NODE_ENV="production"
export CORTEX_RBAC_DISABLED="${CORTEX_RBAC_DISABLED:-0}"

# Cross-base bridge whitelist — explicit actor:target pairs that bypass the
# default "deny cross-base" rule. EMPTY by default (single-agent / no cross-base
# messaging). Multi-agent operators set this to a comma-separated pair list, e.g.
# CORTEX_BRIDGE_CROSS_BASE_PAIRS="agentA:agentB,agentB:agentA".
export CORTEX_BRIDGE_CROSS_BASE_PAIRS="${CORTEX_BRIDGE_CROSS_BASE_PAIRS:-}"

# RBAC scope matrix canonical location: the scope-config loader reads ONLY
# $STATE_DIR/scope-rules.json (no tmp fallback as of 2026-06-09;
# fail-closed if missing). Canonical home is state/ (mode 700, operator-only).
# Derived from $STATE_DIR (not hard-coded) so a non-default CORTEX_DATA_DIR
# loads scope rules from the SAME root as the DB/identity/state instead of
# silently reading from the $CORTEX_HOME default (Task-90 finding #10).
# Locked 2026-05-28; STATE_DIR-derived 2026-06-03.
export CORTEX_SCOPE_RULES_PATH="$STATE_DIR/scope-rules.json"

cd "$REBUILD_ROOT"

echo "run-prod.sh: starting production services"
echo "  DATA_DIR=$DATA_DIR"
echo "  GATEWAY_PORT=$GATEWAY_PORT"
echo "  PLATFORM_PORT=$PLATFORM_PORT"
echo "  DB=$DB_PATH"
echo "  ADMIN_SOCKET=$CORTEX_ADMIN_SOCKET"

# --- start gateway -----------------------------------------------------------
echo "run-prod.sh: starting gateway..."
nohup bun "$REBUILD_ROOT/services/gateway/server.js" \
  > "$LOG_DIR/gateway.log" 2>&1 &
GATEWAY_PID=$!
echo "$GATEWAY_PID" > "$GATEWAY_PID_FILE"
echo "run-prod.sh: gateway pid=$GATEWAY_PID, log=$LOG_DIR/gateway.log"

# Gateway must bind before platform tries to proxy through it.
sleep 1

# --- start platform-backend --------------------------------------------------
echo "run-prod.sh: starting platform-backend..."
nohup bun "$REBUILD_ROOT/platform/backend/server.js" \
  > "$LOG_DIR/platform.log" 2>&1 &
PLATFORM_PID=$!
echo "$PLATFORM_PID" > "$PLATFORM_PID_FILE"
echo "run-prod.sh: platform pid=$PLATFORM_PID, log=$LOG_DIR/platform.log"

# --- verify both processes are alive after a short settle --------------------
sleep 1

FAILED=0
if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
  echo "run-prod.sh: ERROR — gateway (pid=$GATEWAY_PID) exited immediately." >&2
  echo "  Check: $LOG_DIR/gateway.log" >&2
  FAILED=1
fi

if ! kill -0 "$PLATFORM_PID" 2>/dev/null; then
  echo "run-prod.sh: ERROR — platform-backend (pid=$PLATFORM_PID) exited immediately." >&2
  echo "  Check: $LOG_DIR/platform.log" >&2
  FAILED=1
fi

if [[ "$FAILED" == "1" ]]; then
  # Best-effort cleanup of whatever is still running.
  kill -TERM "$GATEWAY_PID"  2>/dev/null || true
  kill -TERM "$PLATFORM_PID" 2>/dev/null || true
  rm -f "$GATEWAY_PID_FILE" "$PLATFORM_PID_FILE"
  exit 1
fi

echo "run-prod.sh: both services up."
echo "  Gateway:  http://127.0.0.1:${GATEWAY_PORT}"
echo "  Platform: http://127.0.0.1:${PLATFORM_PORT}"

# ---------------------------------------------------------------------------
# OPERATOR RECOVERY — manual FS→DB reconcile (Phase 4, CORTEX_FOLDER_AUTHORITY)
#
# The D2 endpoint (POST /v1/api/tasks/reconcile) requires:
#   1. CORTEX_FOLDER_AUTHORITY=1 persisted in $STATE_DIR/runtime.env
#   2. A Unix admin-socket connection (not a TCP/HTTP call)
#   3. An explicit JSON body with "dry_run": false to perform live writes
#
# A bare POST (no body, or any body other than {"dry_run": false}) returns a
# diff report ONLY — no DB rows are modified.
#
# Dry-run (inspect divergence, no writes):
#   curl --unix-socket "$STATE_DIR/admin.sock" \
#     -s -X POST http://localhost/v1/api/tasks/reconcile \
#     -H 'Content-Type: application/json' \
#     | jq .
#
# Live recovery (apply FS→DB repairs — EXPLICIT boolean false required):
#   curl --unix-socket "$STATE_DIR/admin.sock" \
#     -s -X POST http://localhost/v1/api/tasks/reconcile \
#     -H 'Content-Type: application/json' \
#     -d '{"dry_run": false}' \
#     | jq .
#
# To activate the endpoint (if not already enabled):
#   echo 'CORTEX_FOLDER_AUTHORITY=1' >> "$STATE_DIR/runtime.env"
#   # Then restart both services via this script.
# ---------------------------------------------------------------------------
