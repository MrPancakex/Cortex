#!/usr/bin/env bash
set -euo pipefail

echo "[cortex] Starting development environment..."

# Start Vite dev server in the background
bunx vite dev --port 5173 &
VITE_PID=$!

# Start Express backend
bun platform/backend/server.js &
BACKEND_PID=$!

# Wait for both processes
wait $VITE_PID $BACKEND_PID
