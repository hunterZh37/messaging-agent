# System Diagram Automation: Design Spec

Date: 2026-09-06
Status: approved by operator (deterministic variant; replaces the earlier `claude -p` hook)
Depends on: `docs/superpowers/specs/2026-09-06-messaging-agent-design.md` (the system this diagram shows)

## 1. What this is

Two pieces keep `docs/diagrams/system-architecture.{json,html}` truthful:

1. **A rule in `CLAUDE.md`**: whoever changes the architecture edits the archify
   JSON in the same change and renders it. Claude Code does this inside the
   session already running, so it costs nothing extra.
2. **A git `post-commit` hook** that re-renders the HTML with archify `deliver`
   whenever a commit changes the JSON, and commits the HTML if it was left out.
   Deterministic, about 0.2 s, no model call.

There is no separate agent. Archify only renders JSON to HTML; deciding what the
architecture is stays with the author of the change.

## 2. Decisions

| Question | Decision |
|---|---|
| Who updates the JSON | the author of the architectural change, per `CLAUDE.md` |
| Trigger for rendering | git `post-commit`, enabled per clone with `git config core.hooksPath .githooks` |
| Model calls | none |
| Result | HTML committed as `diagram: render <short-sha>` only when the author forgot to commit it |
| Blocking | the hook runs synchronously; `deliver` takes about 0.2 s |

## 3. The hook: `.githooks/post-commit`

Exit 0 immediately when any of these hold:

- `ARCHIFY_HOOK=1` (the hook's own commit).
- `docs/diagrams/system-architecture.json` is not among the commit's changed paths.
- `~/.claude/skills/archify/bin/archify.mjs` is missing (warn on stderr).

Otherwise:

1. `node <archify> deliver architecture <json> <html> --quality showcase --json`,
   output to `.git/archify.last-output`.
2. On success with the HTML unchanged: log `rendered, html unchanged`.
3. On success with the HTML changed: `ARCHIFY_HOOK=1 git commit -o -m "diagram: render <sha>" -- <html>`, log `rendered, committed <new-sha>`.
4. On failure: warn on stderr, log `deliver-failed`. `deliver` preserves the previous HTML, so nothing is committed.

Log file: `.git/archify.log`, one line per event.

## 4. Known limits (accepted)

- If the JSON is wrong or stale, the diagram is wrong. The `CLAUDE.md` rule is the
  only guard, the same trust already placed in keeping the spec current.
- A failed `deliver` (invalid JSON) leaves the old HTML in place and a warning in
  the commit output. Fix the JSON and commit again.
- Clones without `core.hooksPath` set render nothing; the author's own `deliver`
  run still covers them.

## 5. Testing

1. `bash -n .githooks/post-commit`.
2. Commit without touching the JSON: no log line.
3. Commit JSON and HTML together after running `deliver`: log `rendered, html unchanged`, no extra commit.
4. Commit a JSON label change without re-rendering: a `diagram: render …` commit appears with the HTML.
5. Commit invalid JSON: warning on stderr, `deliver-failed` in the log, HTML untouched.
