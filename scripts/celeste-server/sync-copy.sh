#!/bin/bash
# Brings the server's own copy of Celeste up to date with this checkout's main
# branch, and its .env with this checkout's (2026-09-15). The copy lives outside
# the protected folders so the login service may read it. Only the copy is
# touched: anything changed inside it by hand is replaced.
set -euo pipefail
SOURCE="$1"
DEST="$2"
if [ ! -d "$DEST/.git" ]; then
  git clone --quiet --branch main "$SOURCE" "$DEST"
else
  git -C "$DEST" fetch --quiet "$SOURCE" main
  git -C "$DEST" reset --quiet --hard FETCH_HEAD
fi
cp "$SOURCE/.env" "$DEST/.env"
chmod 600 "$DEST/.env"
echo "Server copy at $DEST is at $(git -C "$DEST" log --oneline -1 | cut -c1-72)"
