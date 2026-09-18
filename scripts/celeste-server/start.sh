#!/bin/bash
# Celeste's always-on server (2026-09-14, mobile option 1). Run by launchd at
# login and again whenever it stops: installs dependencies, builds the web
# app, and serves it on 127.0.0.1 only. The phone reaches it through
# `tailscale serve`, never through an open port.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${CELESTE_PORT:-3100}"
# launchd starts with a bare PATH; install.sh writes the real one into the agent.
export PATH="${CELESTE_PATH:-/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin}"

# No NODE_ENV here (2026-09-15): set to production it made pnpm refuse the
# install it had just made, and `next start` runs in production by itself.
unset NODE_ENV
cd "$ROOT"
echo "[$(date '+%F %T')] celeste: starting from $ROOT on port $PORT"
# Never a question: a login service has no one to answer pnpm's "remove the
# modules directories and reinstall?" (2026-09-15), and waiting on it left the
# build without TypeScript.
CI=true pnpm install --frozen-lockfile --config.confirm-modules-purge=false
cd apps/web
./node_modules/.bin/next build
exec ./node_modules/.bin/next start -p "$PORT" -H 127.0.0.1
