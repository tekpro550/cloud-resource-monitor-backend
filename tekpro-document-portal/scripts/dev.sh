#!/usr/bin/env bash
# Runs the API (port 3000) and the web app (port 5173) together. Ctrl+C stops both.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "No .env found. Run: npm run setup:dev" >&2; exit 1; }
trap 'kill 0' INT TERM EXIT
npm run dev:backend &
npm run dev:frontend &
echo "Portal starting: open http://localhost:5173 (Ctrl+C to stop)"
wait
