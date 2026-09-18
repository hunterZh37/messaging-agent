#!/bin/bash
# After pushing new work to main: refresh the server's copy and restart it (2026-09-15).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SERVER_DIR="${CELESTE_SERVER_DIR:-$HOME/celeste-server}"
"$ROOT/scripts/celeste-server/sync-copy.sh" "$ROOT" "$SERVER_DIR"
launchctl kickstart -k "gui/$(id -u)/com.celeste.server"
echo "Celeste is restarting with the new build; about a minute. Log: $HOME/messaging-agent/logs/server.log"
