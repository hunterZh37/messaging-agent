# Security

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's
[security advisories](https://github.com/hunterZh37/messaging-agent/security/advisories/new),
which is a private channel between you and the maintainer.

Tell me what you can: what the problem is, how to reproduce it, and what an
attacker could do with it. A rough report is far better than none.

This is a personal project maintained by one person. I will try to reply within
a week, but there is no guaranteed response time and no bounty. If a fix
matters to you and none is coming, the licence lets you fork and fix it.

## What this software touches

Worth knowing if you are looking for problems, and worth knowing before you run
it:

- **Your mail and chats, in the clear.** Everything synced is stored
  unencrypted in SQLite under `~/messaging-agent` (or `MESSAGING_AGENT_DATA_DIR`).
  It is exactly as private as your Mac is. Anything with read access to your
  home directory can read all of it.
- **Credentials.** IMAP app passwords live in the database, and OAuth refresh
  tokens for Gmail and Outlook live beside them. `.env` holds your Anthropic
  key and, optionally, OAuth client secrets and a scheduling agent's token.
- **Read access to your chat history.** On macOS the app reads the databases
  Messages and WhatsApp already keep, which requires Full Disk Access.
- **It can send.** Mail goes out over SMTP or the provider's API, and chats are
  sent by driving the desktop apps. Nothing is sent without a human pressing
  send, and that gate is a security property, not just a UX one.
- **Model calls.** Sorting, drafting and Ask send message text to whichever
  model you configured. Sorting can be pointed at a local model instead, in
  which case nothing leaves the machine.

## How it is meant to be exposed

- The web app **binds to `127.0.0.1` only**. It is not designed to face the
  internet and has no multi-user model, no per-user authorization, and one
  shared passcode.
- To reach it from a phone, put it on a private network. Tailscale with
  `tailscale serve` is what it was built against. **Do not port-forward it.**
- `CELESTE_PASSCODE` is a single shared secret with no rate limiting and no
  lockout. It keeps a stranger on your tailnet out. It is not a login system.

Reports that amount to "it is insecure if you expose it to the internet" are
understood and are out of scope. Reports that it leaks or sends something
without the operator's approval are very much in scope.
