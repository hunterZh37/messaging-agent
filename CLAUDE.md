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
