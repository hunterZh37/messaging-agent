# messaging-agent (Celeste)

## System diagram

`docs/diagrams/system-architecture.json` is the architecture source of truth (archify).
When a change adds, removes, renames, or re-wires a component, boundary, data store,
external service, or runtime process, or changes how data flows between them, edit
that JSON in the same change and render it:

```bash
node ~/.claude/skills/archify/bin/archify.mjs deliver architecture docs/diagrams/system-architecture.json docs/diagrams/system-architecture.html --quality showcase --json
```

Commit the JSON and HTML together. The post-commit hook in `.githooks/` re-renders
the HTML if it was left out.

The pre-commit hook enforces this in Claude Code sessions: a commit that adds, removes
or renames a source module, changes a runtime dependency, or touches how the server
starts is refused until the JSON is staged (`tools/diagram-drift.mjs`). If you looked
and nothing in the diagram changes, commit with `DIAGRAM_UNCHANGED=1`. Commits made
outside Claude Code are synced by a background agent instead (`tools/diagram-sync.sh`).
`pnpm diagram` serves a live view that re-renders on save.
Spec: `docs/superpowers/specs/2026-09-21-live-diagram-design.md`.
