# The inbox is working memory; the archive is the disk

Operator, 2026-10-12:

> we have the inbox and we have archive. And Inbox is like RAM and Archive is
> like SSD. Inbox is supposed to be temporary and Archive is supposed to be
> long-term storage. For anything that is worth knowing, create a button that
> allows me to migrate all the worth-knowing messages to the archive with one
> click of a button.

They arrived at this by asking whether Archive and Worth Knowing were the same
thing. They are not, and the difference is the whole design: Worth Knowing says
how much a message wants from them, Archive says whether it is in the mailbox
at all.

The point of it, in their words: *"The goal here is that I want to reach inbox
zero. I want to have the confidence that I have personally seen every single
email out there."* That sentence decides more of this design than the metaphor
does — in particular it is why nothing unopened is ever swept, and why the
number that measures the goal is Unopened rather than Inbox.

## 1. What this is

Three rows that each had their own logic now have one story.

| | is | holds |
|---|---|---|
| **Inbox** | the working set | what they are dealing with |
| **Worth Knowing** | what is up for eviction | mail that wants nothing from them |
| **Archive** | storage | everything else, found by searching |

Nothing in that is new behaviour. What is new is a button that acts on it, and
a sidebar that reads as one idea rather than three.

**Why now and not a month ago.** Archiving hard is only safe if finding things
again is reliable, and until 9 October it was not: search matched words, so
mail worded differently from the question was effectively lost. Semantic search
now covers all 94,675 messages. The filing system this spec describes rests on
that and would have been a bad idea without it.

## 2. Decisions

**The sweep moves threads, not messages.** `hidden_at` is a column on `threads`
(`db/schema.ts:142`), and the inbox shows a thread by its newest message. A
thread sweeps only when its **newest inbox message** is Worth Knowing — one
whose latest message needs a reply must never go, however much older Worth
Knowing mail it contains.

**The button takes everything they have read.** No waiting period: "I'm saying
there should be a button where I can just one-click and archive everything"
(2026-10-12, asked for twice — a fortnight's delay was written here first, and
it was caution of mine rather than anything they wanted).

The protection they asked for was never about age. It is that they have seen
it, and that holds absolutely whatever window a caller asks for. Age only ever
decided how long read mail that wants nothing from them sat in front of mail
that does, which is the thing the button exists to end.

`sweepable` still takes a `days`, and the tests still cover one, because
"everything older than N" is a reasonable thing to want later. The button does
not ask for one.

**Nothing they have not opened is ever swept** (operator, 2026-10-12: "I want
to have the confidence that I have personally seen every single email out
there"). This is a guarantee, not a filter, and the difference matters: it was
first left out of this spec on the grounds that it barely excludes anything —
they open 1,268 of 1,300 inbox threads — which is the wrong test. A promise is
not worth less because it is rarely called upon. Today it would hold back 0 of
the 262 sweepable threads, so it costs nothing and secures everything.

What it buys is the goal itself. An inbox that empties on its own is not an
inbox they have read; it is an inbox that got quieter. With this rule the only
way a thread leaves is that they looked at it first, so an empty inbox means
what they want it to mean.

**The sweep is undoable as one action.** `hideThreads` already stamps every
thread in a batch with the same `hidden_at` (`queue/trash.ts:127`), so the
sweep's own timestamp identifies exactly what it moved — no new column, no
guessing. Undo lives in the toast, the way removing a person already works
(2026-09-28), and reaches no further than that toast.

**Archive loses its count.** Nobody checks how full their disk is. A number
there invites reading it as a list to get through, which is the opposite of
what it holds.

## 3. The shape of it

**The sweep**, in `packages/core/src/queue/`:

```
sweepable(db, { days }) -> threadIds     // opened, quiet, newest verdict `knowing`, not hidden
sweepWorthKnowing(db, { days }) -> { moved, at }
```

`sweepWorthKnowing` calls the existing `hideThreads`, so one path archives mail
however it is triggered, and returns the `at` the batch shares. Undo is
`unhideThreads` over the ids, which already exists (`queue/trash.ts:139`).

**The button** sits on the Worth Knowing row, showing what it would move —
"Archive 262" — and nothing when there is nothing to move. Pressing it says
what happened and offers Undo, and the Undo puts back exactly the threads that
went, not everything archived since.

**The sidebar**, re-read as working set and storage:

- **Unopened** is the number that measures the goal, so it is the bold one.
  Inbox zero is reachable by sweeping; *seen everything* is only reachable by
  looking, and this is the only row the sweep can never touch. It falls when
  they read, and nothing else moves it.
- **Inbox** keeps its count, plainly. It is how much is in working memory.
- **Worth Knowing** keeps its count and gains the sweep button.
- **Archive** shows no count and leads with search.

**What this must not become.** RAM is volatile and a disk is slow; neither is
true here, and the UI must not imply either. Nothing in the inbox is at risk of
being lost, and the archive is not a slower place — it is the same search,
instantly. If archiving ever feels like putting mail beyond reach, the design
has failed and people will stop doing it.

## 4. Known limits (accepted)

- Quietness is a proxy for not caring. A thread Celeste mislabelled and the
  operator ignored sweeps exactly like one she read right. This is why the
  sweep says what it moved and offers Undo rather than going quietly.
- Undo lives only as long as the toast. A sweep regretted tomorrow is undone
  thread by thread from the Archive row, as it is today.
- The sweep is manual. Nothing archives on its own, and nothing in this spec
  changes that — the sorter has never written `hidden_at` and still cannot.
- Unopened mail accumulates until they open it, and the sweep will never help.
  That is the design working: it is the part of the inbox that is genuinely
  theirs to clear, and 28 threads are sitting in it today.
- A thread read this morning and meant to be returned to is archived by this
  button along with everything else. It is one search away and the toast undoes
  it, but the button is blunt by request and that is the edge it has.

## 5. Testing

- `sweepable`: a thread never opened is never returned, however quiet and
  however Worth Knowing — the guarantee this rests on; a thread whose newest
  message needs a reply is never returned,
  however much Worth Knowing sits behind it; a thread quiet for 13 days is not
  returned and one quiet for 15 is; an already-archived thread is not returned
  twice.
- `sweepWorthKnowing`: every returned thread shares one `at`; calling it twice
  moves nothing the second time.
- Undo restores exactly that batch and leaves threads archived by hand alone.
- The button's label counts what would move, and the button is absent at zero.
- Archive's row renders without a count, and the Inbox's remains.
