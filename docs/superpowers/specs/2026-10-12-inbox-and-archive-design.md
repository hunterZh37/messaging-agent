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

**Stale means the thread has gone quiet: no new message for 14 days.**
Measured on `threads.last_message_at`, not on the age of any one message,
because a six-month-old thread that got a reply yesterday is live.

Their own mailbox, on the day this was written: 311 Worth Knowing threads, of
which 262 are quiet for 14 days or more. At 90 days it would still be 155, so
the pile is dead either way; 14 is where mail from the last fortnight still
gets their eyes. The number is a named constant and expected to move.

**Being read is deliberately not a criterion.** It sounds right and does
nothing: they open 1,268 of 1,300 inbox threads. Everything in there has been
looked at, so it separates nothing, and a rule that never excludes anything is
a rule that misleads whoever reads it next.

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
sweepable(db, { days }) -> threadIds     // quiet, newest verdict `knowing`, not hidden
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

- **Inbox** keeps its count, and is the only bold one. It is pressure, not
  information: the number is meant to be falling.
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
- Fourteen days is a guess, informed by their distribution and nothing else.

## 5. Testing

- `sweepable`: a thread whose newest message needs a reply is never returned,
  however much Worth Knowing sits behind it; a thread quiet for 13 days is not
  returned and one quiet for 15 is; an already-archived thread is not returned
  twice.
- `sweepWorthKnowing`: every returned thread shares one `at`; calling it twice
  moves nothing the second time.
- Undo restores exactly that batch and leaves threads archived by hand alone.
- The button's label counts what would move, and the button is absent at zero.
- Archive's row renders without a count, and the Inbox's remains.
