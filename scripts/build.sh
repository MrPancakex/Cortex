#!/usr/bin/env bash
set -euo pipefail

echo "[cortex] Building frontend..."
bunx vite build

echo "[cortex] Build complete."
