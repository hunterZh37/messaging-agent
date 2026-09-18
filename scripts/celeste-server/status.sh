#!/bin/bash
# Is Celeste's always-on server up, and can the phone reach it? (2026-09-15)
set -uo pipefail
PORT="${CELESTE_PORT:-3100}"
LOGS="$HOME/messaging-agent/logs"
for label in com.celeste.server com.celeste.awake; do
  if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then echo "agent $label: loaded"; else echo "agent $label: not loaded"; fi
done
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/unlock")
echo "server on 127.0.0.1:$PORT: ${code/000/not answering}"
if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
  echo "tailscale: connected"
  tailscale serve status 2>&1 | head -3
  phones=$(tailscale status --json 2>/dev/null | python3 -c 'import sys,json; j=json.load(sys.stdin); print(sum(1 for p in (j.get("Peer") or {}).values() if p.get("OS") in ("iOS","android")))' 2>/dev/null)
  echo "phones on the network: ${phones:-unknown}"
else
  echo "tailscale: not connected"
fi
if [ -f "$LOGS/server.log" ]; then
  echo "recent errors:"
  grep -iE "error|failed|cannot" "$LOGS/server.log" | tail -5 | cut -c1-160
fi
