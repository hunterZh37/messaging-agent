# Handing work to a scheduling agent

A mail thread often ends in something to do: send a document by Friday, or
show up at three on Thursday. **Add to Alex** on a thread turns that into an
item in a scheduling agent, without leaving the thread.

This is optional. Leave `ALEX_MCP_URL` and `ALEX_MCP_TOKEN` unset and the
button simply says it is not connected.

## What it sends

Two kinds, and nothing else:

| Kind | Needs | Lands as |
|---|---|---|
| **Actionable** | a title and a day, optionally a time | a day-scoped to-do |
| **Event** | a title, a start and a length | a real calendar event |

Neither carries attendees, so nothing is sent to anyone. An event is for a
time the other side has already agreed. Proposing times is a booking link's
job, not this one's.

When you give an item a time, the day's free slots are read back from the
agent and offered as chips. They are suggestions: the field still accepts any
time you type, because these are *bookable* slots with working hours and
notice periods applied, and an actionable at 8pm is nobody's meeting.

## What it expects on the other end

An MCP server over [Streamable HTTP](https://modelcontextprotocol.io) that
answers `tools/call` and implements three tools:

| Tool | Arguments | Returns |
|---|---|---|
| `create_actionable` | `title`, `dayISO`, optional `startISO` + `endISO` | an id |
| `create_event` | `title`, `startISO`, `endISO` | an id |
| `get_availability` | `startISO`, `endISO`, `durationMinutes` | `{ slots: [{ start, end }], timezone }` |

`create_actionable` and `create_event` are expected to sit behind a bearer
token, and `get_availability` may be public. Celeste sends
`Authorization: Bearer <ALEX_MCP_TOKEN>` when it has one.

The server may be stateless: Celeste sends one JSON-RPC request per POST and
performs no `initialize` handshake. A tool that refuses should answer with a
normal result carrying `isError: true` and a human-readable message. Celeste
shows that message verbatim on the thread.

The reference implementation this was built against is
[agentic-scheduling](https://github.com/hunterZh37/agentic-scheduling).

## How it behaves

- **Nothing is written unattended.** You fill the form in and press Add. No
  model is involved on either side, and the tools are ordinary code over the
  agent's database.
- **Every attempt is recorded on the thread**, success or failure. A refusal
  keeps its row with the agent's own words and a **Try again** beside it.
- **There is no undo.** Once an item is in, Celeste cannot retract it.
  Remove it in the scheduling agent.

## Configuring it

```
ALEX_MCP_URL=https://your-agent.example.com/api/mcp
ALEX_MCP_TOKEN=<the bearer token its private tools expect>
```

There is deliberately no default URL. An install that has not been configured
must never call somebody else's server.
