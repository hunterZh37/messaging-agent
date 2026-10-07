# Semantic search: finding mail by what it meant

Operator, 2026-10-07: "Please improve the search capability. Sometimes when I
ask to find content for certain emails, it will take two tries." And, once the
two halves were measured: "I don't need the Chinese but we need to do semantic
search, definitely."

## 1. What this is

Ask Celeste finds mail with a word index. The index knows the words a message
contains and nothing about what it meant, so a question that uses different
words than the mail finds nothing, Celeste guesses again, and the operator
counts two tries.

Measured against their own mailbox, 94,215 messages indexed:

| asked for     | found today |
|---------------|-------------|
| `invoice`     | 297         |
| `invoices`    | 114         |
| `invoicing`   | 3           |
| `meetings`    | 194         |
| `meeting`     | 1,422       |

The same subject, three ways of writing it, three different answers. Speed is
not the problem: every one of those searches returned in under 10ms.

This adds a second way to search — by meaning — and keeps the first.

## 2. Decisions

**Both, merged, not one or the other.** A vector search is good at "the thing
Keith said about billing" and bad at `IOE8022910507`. Those identifiers are
real searches: that receipt number appears in 71 of their messages, an order
number in 4, and an embedding model maps such a string to noise. The word
index answers those perfectly today and keeps doing so.

**Stemming on the word half.** `tokenize='porter unicode61'` instead of
`unicode61` collapses invoice/invoices/invoicing to one entry; measured, that
turns the 3 above into 354 and the 194 into 2,614. One word of schema, and the
index rebuilds in about 1.0 second, measured against 94,242 real messages
after wrapping the refill in one transaction.

This line used to say 1.2 seconds, estimated rather than measured against
the shipped code. The code that shipped did not wrap the refill in a
transaction, so the real cost was 876.5 seconds — about 188,000 separate
autocommitted statements instead of one — until that was fixed (2026-10-07).
Measure what ships, not what a plan predicted.

**Newest first, trickling in the background** (operator's choice, 2026-10-07).
About 92,500 messages are unembedded, at roughly 37ms each: an hour of work if
it were done in one go, which would hold up the sorter, since both share the
one local model. So it is done a batch at a time on the server's own clock,
newest first, and search improves over the first minutes for the mail most
likely to be searched.

**Nothing for Chinese.** The same measurement showed Chinese search barely
works — 谢谢 is in five messages and the index finds two — and spacing CJK
characters at index time would fix it. The operator does not want it
(2026-10-07), so it is not built. Written down because the next person to read
the index will see the gap and should know it was a decision.

## 3. The shape of it

Everything below already exists except where marked **new**.

**The model.** `nomic-embed-text`, 768 dimensions, on Ollama on the operator's
own Mac. No API spend, nothing leaves the machine.

**The store.** `message_embeddings`, a `sqlite-vec` `vec0` virtual table in the
same database file as the mail. `embedding_state` records what was embedded
and a hash of the text it came from, so nothing is embedded twice and a
message whose text changed is redone.

**Embedding.** `embedPending(db, embedder, { accountId, limit })` in
`projects/classify.ts` already selects candidates `ORDER BY sent_at DESC`,
skips what is unchanged, and writes vectors and state in one transaction. It is
called today only as a side effect of sorting one account.

- **new** A clock on the server, beside the mail clock, calling `embedPending`
  across every account a batch at a time until nothing is pending, then
  resting. It yields to the sorter: one local model, and a question the
  operator is waiting on beats a backfill they are not.

**Searching.** `searchMessages(db, query, opts)` in `chat/search.ts` runs the
word index (AND, then OR) and is what the chat's `search_inbox` tool calls.

- **new** `searchByMeaning(db, embedder, query, opts)`: embed the query with
  `QUERY_PREFIX` — which exists in the code already, unused, and is what nomic
  wants for the asking side of an asymmetric pair — then
  `SELECT message_id, distance FROM message_embeddings WHERE embedding MATCH ?
  AND k = ?`, the same call the sorter's examples make.
- **new** A merge. Both halves return ranked lists; the result interleaves them
  so an exact-string hit and a meaning hit both surface, dedupes by message id,
  and keeps the existing `SearchFilters` (account, project, folder, dates) by
  applying them to the merged set.

**Failure.** `db.vecAvailable` is false when the extension will not load and
`EmbeddingsUnavailableError` is thrown when Ollama is not running. Either way
search falls back to the word index alone and says nothing about it: the
operator asked a question and half an answer beats an error.

## 4. Known limits (accepted)

- A message is embedded from its subject and body with quoted history stripped;
  attachments are not read, so a search cannot find what only a PDF says.
- The first minutes after this ships, only recent mail answers to meaning.
  Older mail answers to words, as it does today, until the trickle reaches it.
- Vectors cost about 280MB on top of a 280MB database.
- Stemming is English. A search in another language is no worse than today, and
  no better.

## 5. Testing

- The merge, as a pure function: a word hit and a meaning hit for one message
  appear once; an exact-identifier hit is not pushed off the list by meaning.
- `searchByMeaning` against a seeded database with known vectors.
- Ollama down, and the vector extension missing: both fall back to words, and
  neither throws.
- The stemming change, measured the way it was measured here: invoice /
  invoices / invoicing return one answer.
- The trickle: it embeds newest first, it stops when nothing is pending, and it
  does not run while a sort is running.
