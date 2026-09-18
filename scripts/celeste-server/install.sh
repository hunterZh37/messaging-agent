#!/bin/bash
# Installs Celeste as an always-on server for this Mac user (2026-09-14):
#   1. a launchd agent that runs start.sh at login and restarts it if it stops,
#   2. a second agent that keeps the Mac from sleeping while it is on power,
#   3. `tailscale serve`, which gives the phone an HTTPS address for it.
# Undo everything with uninstall.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# The server runs from its own copy outside Desktop, Documents and Downloads
# (2026-09-15): macOS does not let a login service read those folders, and the
# first install died on "Operation not permitted". The copy is also clear of
# iCloud's duplicate files.
SERVER_DIR="${CELESTE_SERVER_DIR:-$HOME/celeste-server}"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/messaging-agent/logs"
SERVER="com.celeste.server"
AWAKE="com.celeste.awake"
PORT="${CELESTE_PORT:-3100}"
PATH_FOR_AGENT="$(dirname "$(command -v node)"):$(dirname "$(command -v pnpm)"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

say() { printf '%s\n' "$*"; }

if ! grep -q '^CELESTE_PASSCODE=.\{8,\}' "$ROOT/.env" 2>/dev/null; then
  say "Stop: no CELESTE_PASSCODE of at least 8 characters in $ROOT/.env."
  say "Add a line like CELESTE_PASSCODE=your-passcode-here, then run this again."
  exit 1
fi

# Keys the server needs that the dev setup may have and this checkout may not (2026-09-15).
for key in ANTHROPIC_API_KEY MICROSOFT_CLIENT_ID GOOGLE_CLIENT_ID CELESTE_VAPID_PUBLIC; do
  if ! grep -q "^$key=." "$ROOT/.env" 2>/dev/null; then
    say "Note: $key is not set in $ROOT/.env; what needs it (Ask, Outlook, Google sign-in, notifications) will not work."
  fi
done

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  say "Stop: something is already listening on port $PORT (a dev server?). Stop it, then run this again."
  exit 1
fi

mkdir -p "$AGENTS" "$LOGS"
"$ROOT/scripts/celeste-server/sync-copy.sh" "$ROOT" "$SERVER_DIR"
chmod +x "$SERVER_DIR/scripts/celeste-server/start.sh"

cat > "$AGENTS/$SERVER.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$SERVER</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$SERVER_DIR/scripts/celeste-server/start.sh</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CELESTE_PATH</key><string>$PATH_FOR_AGENT</string>
    <key>CELESTE_PORT</key><string>$PORT</string>
  </dict>
  <key>WorkingDirectory</key><string>$SERVER_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOGS/server.log</string>
  <key>StandardErrorPath</key><string>$LOGS/server.log</string>
</dict>
</plist>
PLIST

cat > "$AGENTS/$AWAKE.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$AWAKE</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/caffeinate</string><string>-is</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
PLIST

for label in "$SERVER" "$AWAKE"; do
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/$label.plist"
done
say "Celeste is starting. The first start builds the app, about a minute. Log: $LOGS/server.log"

# Wait for it to answer, then look for the one failure launchd hides: the
# server runs outside Terminal, so reading Messages and WhatsApp needs Full
# Disk Access for Node itself (2026-09-15).
for _ in $(seq 1 90); do
  curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/unlock" && break
  sleep 2
done
if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/unlock"; then
  say "Celeste answers on http://127.0.0.1:$PORT."
  sleep 20
  if grep -qiE "unable to open database|SQLITE_CANTOPEN|authorization denied|operation not permitted" "$LOGS/server.log"; then
    say ""
    say "Celeste cannot read Messages or WhatsApp yet. Give Node Full Disk Access:"
    say "  System Settings > Privacy & Security > Full Disk Access > + > $(command -v node)"
    say "Then run: launchctl kickstart -k gui/$(id -u)/$SERVER"
  fi
else
  say "Celeste did not answer within three minutes. Look at the end of $LOGS/server.log."
fi

if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
  tailscale serve --bg "$PORT"
  say ""
  say "On your phone, open the https address below in Safari, unlock, then Share > Add to Home Screen:"
  tailscale serve status
else
  say ""
  say "Tailscale is not running on this Mac yet. Install it, sign in, then run:"
  say "  tailscale serve --bg $PORT"
fi
