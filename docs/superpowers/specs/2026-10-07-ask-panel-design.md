# The Ask panel: results you can argue with

Operator, 2026-10-07, with two screenshots of another product's search results:

> - I have a relevance score and when I hover over the relevance score, it shows
>   why the search results are what I'm asking for.
> - I want the ask list to be floating at the bottom right corner.
> - When I click on the list, it will give me a bigger panel than the ones I have
>   right now.
> - The ranking should display like the ones I have shown you in the picture.

Asked what "the ask list" meant, they chose the Ask Celeste launcher. Asked where
the ranked list should live, they said inside the panel. Asked what writes the
hover text, they chose free by default with an Explain on click. The canvas of
all four is at https://claude.ai/artifact/BvSAXdx84pThXBTEe3BQg1 — "the canvas
design looks good" (2026-10-07).

## 1. What this is

Celeste answers in prose and lists what she leaned on as grey one-line chips:

```
Your Partners In Hope July statement is available · St. Jude C…
+14155550142 · +14155550142
Help give them tomorrow 💛 · St. Jude Children's Research H…
```

Three things are wrong with that. The chips do not say *why* each message is
there, so the only way to check Celeste is to open all of them. They do not say
how strongly each one matched, so a message she is sure of looks exactly like
one she is reaching for. And the panel they sit in is 290px wide, which is why
a subject gets eleven characters before an ellipsis.

Semantic search shipped this morning, which makes the second of those newly
answerable: a hit now knows whether the operator's words were in the message,
or only its meaning was close, or both.

## 2. Decisions

**The launcher floats, bottom right.** It leaves the sidebar. One way in, over
the mail rather than beside it, and `⌘/` still works.

**The panel gets bigger.** 620px against today's 380 default, anchored to the
same corner it opened from, with the existing drag edge and a control to go
full height.

**The ranked cards replace the chips, inside the panel** (operator, 2026-10-07:
"the result ... should be inside the ask list panel"). No separate search page.

**The hover is free; Celeste is asked only on a click.** The text under the
score comes from the signals that produced it and costs nothing. An Explain
link fetches her sentence about that one message, which costs a fraction of a
cent, and only for the result they asked about.

**The score greys out below 70.** Not the operator's instruction; mine, and
reversible. With a list where everything is confident, nothing is.

**No star, no thumbs**, though both are in their screenshots. Celeste cannot
save a message, and nothing would read the feedback. Said here so the gap is a
decision rather than an oversight.

## 3. The shape of it

**The score has to be explainable, because the hover explains it.** That rules
out an opaque blend of weights: every part of the number has to be nameable in
a sentence a person would accept. So it is built from four things that can each
be said out loud:

| part | where it comes from | how it reads |
|---|---|---|
| the words | `bm25()` on `messages_fts`, which the query already orders by but never selects | "matched *job training* in the subject and twice in the body" |
| the meaning | the `distance` column `searchByMeaning` already asks for and currently throws away | "close in meaning to *workforce programs*" |
| both halves | `SearchHit.match`, which shipped today | "found both ways" |
| how recent | `sent_at` against now | "sent 3 days ago" |

A message found by both halves scores above one found by either alone, because
two independent kinds of evidence agreeing is the strongest signal this system
has. Recency is a nudge, not a term that can carry a weak match.

**The weights are not measured.** They cannot be until the scores can be seen
against real questions, which is what this builds. They start as a stated guess
in one named constant and are expected to move.

**Not every citation is a search result.** This is the part that shapes the
work. `toolIds` (`chat/ask.ts:423`) gathers ids from `list_mail`, `get_thread`
and the open thread as well as from `search_inbox`, and `citedMessageIds` picks
whichever of them Celeste actually cited. So a cited message may never have
been ranked by anything. Those cards show everything except the score rail —
the same card, minus a number that would be invented. A card with no score is
honest; a card with a made-up one is not.

**Citations have to carry more.** `citationsFor` (`chat/ask.ts:332`) rebuilds a
`Citation` from `messages` rows by id: subject and sender, nothing else. The
card needs the date, the matching line, how it was found, and the score — all
of which exist at search time and are discarded. `Citation` grows those as
optional fields, and the search hits for a turn are kept long enough to attach
them. Optional because of the paragraph above, and because turns stored before
today have none of it; the panel renders the simple row for those, which is
what it renders now.

**The card**, inside the panel, where the chips are:

```
┌──────────────────────────────────────────────┐
│ Workforce training budget — sign-off  92     │
│ Keith Calix · Inbox · 12 Sep         ▬▬▬▬    │
│ …the ⟨job training⟩ places for 42 people…    │
│ Asks for a decision                          │
└──────────────────────────────────────────────┘
```

Clicking it opens the thread, as the chip does now.

**The hover** is a popover on the score, not a tooltip: it has a link in it, so
it has to survive the pointer travelling into it. Keyboard-reachable, since the
score is the control.

**Explain** is a server action over one message id, returning one sentence.
It is the only part of this that spends money, and it spends it only when
clicked. A failure says so in the popover and leaves the free text standing.

## 4. Known limits (accepted)

- A citation from `get_thread` or `list_mail` has no score, and will not get
  one. Ranking a message nobody searched for would mean inventing a question.
- The score's weights are a guess until they can be looked at. The first week
  of using this is the measurement.
- Explain re-reads one message and says what it is about; it does not re-derive
  the score, so a sentence can describe a message the score rated low.
- The scores move as the backfill proceeds: a message with no vector yet can
  only score on words. This settles once embedding finishes.

## 5. Testing

- The score, as a pure function: both halves agreeing beats either alone; a
  recent message does not outrank a far better match; the output is clamped.
- The hover's sentence, as a pure function of the same parts: it names only the
  parts that actually contributed, and reads as a sentence with one, two or
  four of them.
- A citation with no score renders the card without the rail, and one from
  before today's shape renders the old row.
- The panel at phone width, where a 620px panel cannot float: it covers, as the
  current one does.
- Explain: the click spends once, a second click does not re-ask, a failure
  leaves the free text.
