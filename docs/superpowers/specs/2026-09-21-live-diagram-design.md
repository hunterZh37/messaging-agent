# Live System Diagram: Design Spec

Date: 2026-09-21
Status: approved by operator ("real-time system diagram … every time there is a change to this system, the diagram should update")
Extends: `docs/superpowers/specs/2026-09-06-archify-agent-design.md`

## 1. Why

The 2026-09-06 design kept `docs/diagrams/system-architecture.json` truthful with one
guard: a rule in `CLAUDE.md`. It held for zero commits. By 2026-09-21 the JSON had not
been edited since the first commit, 42 commits earlier, while Jev became the default
sorter, the sorter's fields became one rung, hand corrections became sender rules, and
Alex went from planned to built. The renderer was fine; nothing noticed the drift.

## 2. Decisions

| Question | Decision |
|---|---|
| Who notices drift | `tools/diagram-drift.mjs`, deterministic, no model |
| In a Claude Code session | `.githooks/pre-commit` refuses the commit until the JSON is staged (`CLAUDECODE=1`) |
| Anywhere else | commit goes through; `.githooks/post-commit` starts `tools/diagram-sync.sh` in the background |
| Sync agent | `claude -p`, Sonnet, `--max-budget-usd 2`, `dontAsk`, hooks disabled, may edit only the JSON and run `archify validate` |
| Rendering and committing | stay in shell: `deliver` must pass, then `git commit -o` of JSON + HTML only, as `diagram: sync <sha>` |
| Viewing | `pnpm diagram`: localhost server, re-renders on JSON save, reloads the tab on any HTML change |
| Opt-outs | `DIAGRAM_UNCHANGED=1` (looked, nothing to draw), `DIAGRAM_AUTOSYNC=0` (no background agent) |

## 3. What counts as drift

A change drifts when it touches an architectural path and does not touch the JSON.
Architectural (`tools/diagram-drift.mjs`):

- **Added, removed or renamed** files under `packages/*/src/`, `apps/*/lib/`, `apps/*/app/api/`,
  `apps/cli/`, `scripts/`, and top-level pages `apps/*/app/<route>/page.tsx`. Edits to an
  existing file do not count: the diagram draws modules, not lines.
- **Any edit** to `scripts/celeste-server/`, a `.plist`, or `pnpm-workspace.yaml`: how the
  processes start.
- **Added or removed runtime dependencies** in any `package.json`. Version bumps and
  devDependencies do not count.

Never: tests, fixtures, CSS, images, Markdown, `docs/`. Not the database schema either:
the diagram draws SQLite as one box.

Run against the 42 commits it was written after, it flags 7, including the Jev sorter
(`c694a09`), sender-rule corrections (`fe5a0f2`) and silence detection (`d2462ca`), and
none of the 35 UI and copy commits.

## 4. The sync agent (`tools/diagram-sync.sh <sha>`)

Skips, with a line in `.git/archify.log`, when: another sync holds `.git/diagram-sync.lock`;
the JSON or HTML has uncommitted edits (never overwrite a hand edit); `claude` or archify
is missing. Otherwise:

1. `claude -p` reads the JSON and the commit, edits the JSON only if the shape changed,
   and loops on `archify validate --quality showcase` until the layout passes.
2. No JSON change: log `no change`.
3. `deliver` fails: restore JSON and HTML, log `discarded`.
4. Otherwise commit JSON + HTML as `diagram: sync <sha>` with the agent's one-line summary.
   `ARCHIFY_HOOK=1` keeps the hooks from re-entering.

The agent's full output is in `.git/diagram-sync.last-output`.

## 5. The live view (`tools/diagram-live.mjs`)

- Serves the HTML at `http://127.0.0.1:4178/` with a server-sent-events reload script injected.
- Watches `docs/diagrams/` (the directory, since editors and git replace files by rename).
- JSON content changed → `archify deliver`. Failure → the last good diagram with the
  error in a banner. HTML changed (a render, a commit, a pull, the sync agent) → reload.
- A tab reloads when the server restarts, so it never shows a dead stream as current.

## 6. Known limits (accepted)

- The drift rule is coarse: a helper file flags the same as a new subsystem. The cost of a
  false flag is one look and `DIAGRAM_UNCHANGED=1`; the cost of a miss was 42 commits.
- It cannot see a re-wiring that only edits existing files. `CLAUDE.md` still asks for it.
- Each background sync costs a model call, capped at $2.
- One sync at a time. A commit made during a sync is not queued; the next sync reads the
  code as it is, so it catches up.

## 7. Testing

- `packages/core/test/diagram-drift.test.ts`: what must and must not flag.
- Scratch clone: Claude commit with drift refused; `DIAGRAM_UNCHANGED=1` passes; outside
  Claude a stub agent's edit is rendered and committed; a stub's invalid JSON is discarded;
  a hand-edited JSON is left alone; `DIAGRAM_AUTOSYNC=0` starts nothing.
- One real `claude -p` sync against `c694a09` (Jev).
- Live view: touch without change does nothing; an edit re-renders and reloads; invalid
  JSON shows the banner; the fix clears it.
