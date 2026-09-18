# Contributing

This is a personal tool, published because it might be useful to someone else.
Issues and pull requests are welcome, but there is no support promise and
replies may be slow. If you need something changed and I am not moving, fork
it. That is what the MIT licence is for.

## Running it

```bash
pnpm install
cp .env.example .env    # it explains every value
pnpm web                # http://127.0.0.1:3100
```

macOS, Node 22+, pnpm. `ollama pull nomic-embed-text` if you want project
filing, which is local and free. Full setup is in the [README](README.md).

Then turn the hooks on, once per clone:

```bash
git config core.hooksPath .githooks
```

One of them refuses a commit message carrying a real email address or phone
number. This app is developed against its author's own mailbox, so the
handiest example is always a real person, and a commit message is the one
place `pnpm test` cannot look. It is also where this repository's own leaks
happened: a contact named to explain a bug, a phone number quoted from a row
on screen, two private messages quoted as evidence for a feature.

## Before you open a pull request

```bash
pnpm typecheck
pnpm test
```

Both must pass. There is no CI yet, so this is the whole gate.

`pnpm test` includes a check that no tracked file carries a real address or
number. Fixtures use `@example.com` and the reserved `555` exchange. It cannot
check a name, so that part is still on you.

## What makes a change easy to accept

- **One thing at a time.** A small PR that does what its title says gets read.
- **A test that would have failed before.** Most of this code is about mail
  arriving in odd shapes, and a fixture is worth more than an explanation.
- **Never a real address, phone number or name in a fixture.** Use
  `@example.com` and the `+1415555xxxx` reserved range, as the suite does. Real
  contacts have ended up in this repo before and taking them out again is
  miserable.
- **Comments say why, not what.** The code says what it does. A comment earns
  its place by recording the reason, the bug it came from, or the thing that
  was tried and did not work.
- **Nothing sends without the operator.** Drafting, proposing and filing can be
  automatic. Sending, deleting at the provider, and writing to someone else's
  system are not, and a PR that changes that will be asked to justify it.

## Architecture, briefly

| Path | What |
|---|---|
| `packages/core` | Everything with no UI: connectors, sorting, drafting, projects, search, the database |
| `apps/web` | The Next.js app, the only interface you actually use |
| `apps/cli` | A thin CLI over the same core |
| `docs/diagrams` | Architecture diagrams, rendered from JSON. Edit the JSON, not the HTML |
| `docs/superpowers/specs` | The design document, and where the reasoning lives |

The spec is long but it is the honest record of why things are the way they
are. If a change contradicts it, say so in the PR. The spec can be wrong too.

## Security

Do not open a public issue for a security problem. See [SECURITY.md](SECURITY.md).
