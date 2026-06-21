#!/usr/bin/env bash
# scripts/lib/runtime-env.sh — STRICT allowlist parser for the persisted
# runtime-toggle env file (default: $STATE_DIR/runtime.env).
#
# Task-90 finding #1/#8 (HIGH): run-prod.sh used to `source` this file. Because
# the legacy default path lived under the group-writable data/ dir, any
# shared-group process could replace runtime.env and inject arbitrary shell (or
# silently force CORTEX_RBAC_DISABLED=1) on the next gateway boot.
#
# Two-part hardening:
#   (a) the DEFAULT path moves under the private $STATE_DIR (700, operator
#       only) — done by callers (run-prod.sh, cortex-rbac-toggle.sh);
#   (b) `source` is replaced by this parser, which accepts ONLY `KEY=value`
#       lines for a fixed allowlist of toggle keys, with the value itself
#       validated against a fixed set. No command substitution, no arbitrary
#       shell, no unknown keys.
#
# Usage (source this file, then call):
#   . scripts/lib/runtime-env.sh
#   parse_runtime_env "/path/to/runtime.env"   # exports allowed toggles
#
# Exit status is always 0 (a malformed/absent file is non-fatal — unknown or
# malformed lines are skipped with a warning on stderr). Callers that need a
# missing toggle to fall back to a default just read the env var afterwards.

# Allowed toggle keys. Extend this set (not the parser) to add toggles.
# CORTEX_FOLDER_AUTHORITY=1 enables the D2 manual-trigger admin endpoint
# (POST /v1/api/tasks/reconcile) and declares folder authority. Boot reconcile
# (scanAll) remains unconditional existing behavior — the flag does NOT activate
# or suppress it. Persist in $STATE_DIR/runtime.env and restart the gateway.
CORTEX_RUNTIME_ENV_ALLOWED_KEYS="${CORTEX_RUNTIME_ENV_ALLOWED_KEYS:-CORTEX_RBAC_DISABLED CORTEX_FOLDER_AUTHORITY}"

# Allowed values for boolean-style toggles.
_RUNTIME_ENV_BOOL_VALUES_RE='^(0|1|true|false|yes|no|on|off)$'

# _runtime_env_key_allowed KEY -> 0 if KEY is in the allowlist, 1 otherwise.
_runtime_env_key_allowed() {
  local key="$1" allowed
  for allowed in $CORTEX_RUNTIME_ENV_ALLOWED_KEYS; do
    if [[ "$key" == "$allowed" ]]; then
      return 0
    fi
  done
  return 1
}

# parse_runtime_env FILE
# Reads FILE line-by-line and exports each allowed KEY=value pair. Lines that
# are blank, comments, not strict KEY=value, carry a non-allowlisted key, or
# carry an out-of-range value are skipped (with a stderr warning). Never
# evaluates the file as shell.
parse_runtime_env() {
  local file="$1"
  [[ -n "$file" && -f "$file" ]] || return 0

  local line key value
  # Read from the file directly (not via a pipe) so exports land in THIS
  # shell, not a subshell.
  while IFS= read -r line || [[ -n "$line" ]]; do
    # Strip a single trailing CR (tolerate CRLF files).
    line="${line%$'\r'}"
    # Skip blanks and comments.
    if [[ -z "$line" || "$line" == \#* ]]; then
      continue
    fi
    # Strict KEY=value: KEY is [A-Za-z_][A-Za-z0-9_]*, value is the remainder.
    # The match is wrapped in an `if` so a non-match does not trip `set -e`.
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
    else
      printf 'runtime-env: ignoring malformed line: %s\n' "$line" >&2
      continue
    fi
    # Strip surrounding single/double quotes from the value, if present.
    if [[ "$value" =~ ^\"(.*)\"$ ]]; then
      value="${BASH_REMATCH[1]}"
    elif [[ "$value" =~ ^\'(.*)\'$ ]]; then
      value="${BASH_REMATCH[1]}"
    fi
    if ! _runtime_env_key_allowed "$key"; then
      printf 'runtime-env: ignoring non-allowlisted key: %s\n' "$key" >&2
      continue
    fi
    # Validate the value. All currently-allowed keys are boolean toggles.
    if [[ ! "$value" =~ $_RUNTIME_ENV_BOOL_VALUES_RE ]]; then
      printf 'runtime-env: ignoring out-of-range value for %s: %s\n' "$key" "$value" >&2
      continue
    fi
    # Normalize alternative truthy/falsy spellings to '1'/'0' so runtime
    # checks (routes.js, composer.js) that compare === '1' work for all
    # accepted boolean forms. Without this an operator writing
    # CORTEX_FOLDER_AUTHORITY=true gets the validated form "true" exported
    # and the endpoint silently stays disabled.
    case "$value" in
      true|yes|on)   value='1' ;;
      false|no|off)  value='0' ;;
    esac
    export "$key=$value"
  done < "$file"

  return 0
}
