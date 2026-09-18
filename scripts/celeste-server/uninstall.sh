#!/bin/bash
# Takes Celeste's always-on server back out (2026-09-14): stops both agents,
# removes them, and turns off the Tailscale address. Mail, chats and settings stay.
set -uo pipefail
AGENTS="$HOME/Library/LaunchAgents"
for label in com.celeste.server com.celeste.awake; do
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null
  rm -f "$AGENTS/$label.plist"
done
if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
  tailscale serve --https=443 off 2>/dev/null || tailscale serve reset
fi
echo "Celeste's always-on server is stopped and removed. Its copy at ${CELESTE_SERVER_DIR:-$HOME/celeste-server} is left; delete it if you like."
