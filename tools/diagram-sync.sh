#!/usr/bin/env bash
# Background sync: bring docs/diagrams/system-architecture.json up to date with
# one commit that changed the system's shape but not the diagram.
# Started by .githooks/post-commit for commits made outside Claude Code.
# Spec: docs/superpowers/specs/2026-09-21-live-diagram-design.md
#
#   tools/diagram-sync.sh <sha>
#
# The model only edits the JSON. Rendering, checking and committing stay
# deterministic here: a JSON that fails `deliver` is thrown away, and only the
# JSON and HTML are ever committed.

sha="$1"
[ -n "$sha" ] || { echo "usage: diagram-sync.sh <sha>" >&2; exit 2; }
cd "$(git rev-parse --show-toplevel)" || exit 0
gitdir=$(git rev-parse --absolute-git-dir)
log="$gitdir/archify.log"
json=docs/diagrams/system-architecture.json
html=docs/diagrams/system-architecture.html
archify=~/.claude/skills/archify/bin/archify.mjs
archify_abs="$HOME/.claude/skills/archify/bin/archify.mjs"
short=$(git rev-parse --short "$sha")
say() { echo "$(date '+%FT%T') $short sync: $*" >> "$log"; }

# One sync at a time; a second commit while one runs is picked up next time,
# because the agent reads the code as it is, not just the one diff.
# A lock left by a run that was killed (SIGKILL, sleep, crash: no EXIT trap)
# is reclaimed once its process is gone or it is older than 30 minutes.
lock="$gitdir/diagram-sync.lock"
if ! mkdir "$lock" 2>/dev/null; then
  pid=$(cat "$lock/pid" 2>/dev/null)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && [ -z "$(find "$lock" -maxdepth 0 -mmin +30)" ]; then
    say "skipped, another sync is running (pid $pid)"
    exit 0
  fi
  say "reclaimed a stale lock${pid:+ (pid $pid)}"
  rm -rf "$lock"
  mkdir "$lock" 2>/dev/null || { say "skipped, lost the lock race"; exit 0; }
fi
echo $$ > "$lock/pid"
context="$gitdir/diagram-sync.context.diff"
trap 'rm -rf "$lock" "$context"' EXIT

# Never write over edits someone is making to the diagram by hand.
if ! git diff --quiet HEAD -- "$json" "$html"; then
  say "skipped, $json has uncommitted edits"
  exit 0
fi
command -v claude >/dev/null || { say "skipped, claude not on PATH"; exit 0; }
[ -f "$archify" ] || { say "skipped, archify not found"; exit 0; }

reasons=$(node tools/diagram-drift.mjs --commit "$sha")
say "started (${reasons//$'\n'/; })"

# The agent gets no git at all: `git diff/log/show` all take --output=<path>,
# which would let it write anywhere. The commit is handed over as a file.
git show --stat --patch --no-color "$sha" > "$context"
# What HEAD's diagram was when this started; if it moves, a person got there first.
start_blob=$(git rev-parse -q --verify "HEAD:$json")

prompt="You maintain the archify architecture diagram of this repository: $json.
Commit $sha changed the system's shape without updating it. The drift check flagged:
$reasons

1. Read $json fully and follow its existing conventions exactly (ids, labels, boundaries, connection shapes, cards).
2. Read the commit (stat and patch) in $context, then read the code it touches.
3. If the change adds, removes, renames or re-wires a component, boundary, data store, external service or runtime process, or changes how data flows between them, edit $json to match the code as it is now. Keep edits minimal; do not restyle.
4. If the diagram is already accurate, change nothing.
5. After editing, run: node $archify_abs validate architecture $json --quality showcase
   It checks layout strictly (edges through boxes, label overlaps, side directions). Fix every error it reports,
   using its suggested fixes (prefer automatic routing: drop fromSide/toSide/via on new edges; move labels with labelAt),
   and run it again until it passes. A JSON that does not validate is thrown away.
Edit only $json. Do not render. Never put a real person's name, email or phone number in the diagram.
Finish with one line: CHANGED: <summary> or UNCHANGED: <why>."

out=$(claude -p "$prompt" \
  --model sonnet \
  --max-budget-usd 2 \
  --permission-mode dontAsk \
  --settings '{"disableAllHooks":true}' \
  --allowedTools "Read" "Grep" "Glob" "Edit($json)" "Bash(node $archify_abs validate:*)" \
  --disallowedTools "Read(./.env)" "Read(./.env.*)" \
  2>&1)
echo "$out" > "$gitdir/diagram-sync.last-output"

if git diff --quiet -- "$json"; then
  say "no change ($(printf '%s' "$out" | tail -1 | cut -c1-120))"
  exit 0
fi

if ! node "$archify" deliver architecture "$json" "$html" --quality showcase --json > "$gitdir/archify.last-output" 2>&1; then
  git checkout -q -- "$json" "$html"
  say "discarded, edited JSON failed deliver (see $gitdir/archify.last-output)"
  exit 0
fi

if [ "$(git rev-parse -q --verify "HEAD:$json")" != "$start_blob" ]; then
  git checkout -q -- "$json" "$html"
  say "discarded, $json changed in HEAD while the agent worked"
  exit 0
fi

ARCHIFY_HOOK=1 git commit -q -o -m "diagram: sync $short" -m "$(printf '%s' "$out" | tail -1)" -- "$json" "$html" \
  && say "committed $(git rev-parse --short HEAD)" \
  || { git checkout -q -- "$json" "$html"; say "commit failed, edits discarded"; }
