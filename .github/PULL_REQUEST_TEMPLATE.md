<!--
Thanks for this. A small pull request that does what its title says gets read
soonest. If it is large, say in the first line what the one change is.
-->

## What this changes

<!-- One or two sentences. What is different afterwards? -->

## Why

<!--
The problem, not the patch. What was awkward, or wrong, or slow? If it fixes an
issue, say "Fixes #123".
-->

## How it was checked

<!--
What you actually ran or looked at. "pnpm test" is the floor, not the answer:
say which case you tried by hand, and what you saw.
-->

```bash
pnpm typecheck
pnpm test
```

## Before merging

- [ ] `pnpm typecheck` and `pnpm test` both pass
- [ ] A test that would have failed before this change, where the change is a fix
- [ ] **No real addresses, names or phone numbers in fixtures** — `@example.com`
      and the `555` reserved exchange, as the rest of the suite does. The test
      `packages/core/test/no-real-people.test.ts` checks every tracked file and
      will tell you where; it cannot check a name, so that part is on you
- [ ] No new secret, token or personal default in tracked files; `.env.example`
      updated if a new variable is read
- [ ] Nothing new sends, deletes at a provider, or writes to someone else's
      system without the operator pressing something
- [ ] Comments say *why*, not what
- [ ] `docs/diagrams/system-architecture.json` updated and re-rendered if this
      adds, removes or re-wires a component or a data flow

<!--
If this contradicts docs/superpowers/specs, say so here rather than quietly
diverging. The spec can be wrong too, but it should not be wrong silently.
-->
