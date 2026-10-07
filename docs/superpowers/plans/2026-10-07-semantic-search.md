# Semantic search implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Celeste finds mail by what it meant as well as by the words in it, so a question
that uses different words than the message no longer takes two tries.

**Architecture:** The keyword index keeps answering, with stemming added so
invoice/invoices/invoicing are one word. Beside it, a vector search over the
`sqlite-vec` table Celeste already has, asked with the operator's question embedded by
the local `nomic-embed-text`. The two ranked lists are interleaved, so an exact
identifier still lands first and a meaning match still appears. A clock on the server
embeds the backlog a batch at a time, email before texts, newest first, and yields to
the sorter because both share the one local model.

**Tech Stack:** TypeScript, better-sqlite3 + FTS5 (`porter unicode61`), `sqlite-vec`
(`vec0`, 768 dimensions), Ollama `nomic-embed-text` on 127.0.0.1:11434, drizzle, vitest.

**Spec:** `docs/superpowers/specs/2026-10-07-semantic-search-design.md`

## Global Constraints

- The local model is `nomic-embed-text`, 768 dimensions (`EMBEDDING_DIMENSIONS`,
  `packages/core/src/db/client.ts:17`). No API spend; nothing leaves the operator's Mac.
- Documents are embedded with `DOCUMENT_PREFIX` (`"search_document: "`), questions with
  `QUERY_PREFIX` (`"search_query: "`) — both already in `packages/core/src/projects/classify.ts:99-100`.
- Search must never throw. `db.vecAvailable` false, Ollama down
  (`EmbeddingsUnavailableError`), or a query FTS5 refuses all fall back to the keyword
  half and return hits, never an error.
- No real person's name, email address or phone number in any tracked file
  (`packages/core/test/no-real-people.test.ts` enforces it). Tests use `example.com`.
- Nothing in this plan may touch the live server on 127.0.0.1:3100, `~/celeste-server`,
  or the real database at `~/messaging-agent`.
- Comments are prose that say the operator-facing reason, dated, quoting the operator
  where it earned the change — match the density of the file being edited.
- `pnpm typecheck` and `pnpm vitest run` pass in both `apps/web` and `packages/core`
  before every commit.
- Operator's decision, 2026-10-07: embed **everything, email before texts**. Their
  mailbox is 94,149 messages, of which 86,210 are texts; email finishes in about five
  minutes and the texts trickle in behind over a day. About 290MB of vectors.

## Review Focus

1. **Ollama is not running.** The sorter already survives this; search must too — words
   only, no error shown, no stack trace in the log. (Task 3 and Task 5 tests.)
2. **The vector extension did not load** (`db.vecAvailable === false`, as on a machine
   where `sqlite-vec` fails to load). Every vector path returns empty rather than
   throwing. (Task 3 test.)
3. **A question with no searchable words** — punctuation, an emoji, an empty string.
   `ftsQuery` already returns null for these; the meaning half must not embed them
   either, because an embedding of "???" ranks arbitrary mail highly. (Task 3 test.)
4. **A message the vector table knows but the messages table no longer does** (deleted
   between the two queries). The meaning half must drop it rather than return a hit with
   no subject. (Task 3 test.)
5. **The backlog never finishes** because the embedder keeps failing. The clock must not
   spin hot on a permanent error, and must not log once a second forever. (Task 6 test.)

---

### Task 1: Stemming on the keyword index

**Files:**
- Modify: `packages/core/src/db/client.ts:28` (the FTS5 table definition)
- Modify: `packages/core/src/chat/search.ts` (add `rebuildSearchIndexIfStale`)
- Test: `packages/core/test/chat/search.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `rebuildSearchIndexIfStale(db: Db): boolean` — true when the index was
  dropped and must be refilled by `backfillSearchIndex`.

- [ ] **Step 1: Write the failing test**

In `packages/core/test/chat/search.test.ts`:

```ts
describe("stemming", () => {
  it("answers one word for a word's other endings (operator, 2026-10-07)", () => {
    const db = testDb();
    indexMessageForSearch(db, {
      id: "m1",
      subject: "Invoicing for September",
      fromName: "Sam",
      fromAddress: "sam@example.com",
      bodyText: "The invoices are attached.",
    });
    expect(searchMessages(db, "invoice").map((h) => h.messageId)).toEqual(["m1"]);
    expect(searchMessages(db, "invoicing").map((h) => h.messageId)).toEqual(["m1"]);
    expect(searchMessages(db, "invoices").map((h) => h.messageId)).toEqual(["m1"]);
  });

  it("still finds an identifier exactly, which stemming must not mangle", () => {
    const db = testDb();
    indexMessageForSearch(db, {
      id: "m2",
      subject: "Receipt",
      fromName: null,
      fromAddress: "noreply@example.com",
      bodyText: "Your case number is IOE8022910507.",
    });
    expect(searchMessages(db, "IOE8022910507").map((h) => h.messageId)).toEqual(["m2"]);
  });
});

describe("rebuildSearchIndexIfStale", () => {
  it("drops an index built with the old tokenizer, and leaves a current one alone", () => {
    const db = testDb();
    db.$client.exec("DROP TABLE messages_fts");
    db.$client.exec(
      "CREATE VIRTUAL TABLE messages_fts USING fts5(message_id UNINDEXED, subject, from_name, from_address, body, tokenize='unicode61')",
    );
    expect(rebuildSearchIndexIfStale(db)).toBe(true);
    expect(rebuildSearchIndexIfStale(db)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/core && pnpm vitest run test/chat/search.test.ts`
Expected: FAIL — `searchMessages(db, "invoice")` returns `[]` for a body that says
"invoices", and `rebuildSearchIndexIfStale` is not exported.

- [ ] **Step 3: Change the tokenizer**

In `packages/core/src/db/client.ts`, line 28:

```ts
  // `porter` on top of `unicode61`, so invoice, invoices and invoicing are one
  // word in the index (operator, 2026-10-07: "sometimes when I ask to find
  // content for certain emails, it will take two tries"). Measured against
  // their own mailbox, "invoicing" found 3 messages where "invoice" found 297;
  // stemmed, all three spellings answer with the same 354.
  "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(message_id UNINDEXED, subject, from_name, from_address, body, tokenize='porter unicode61')";
```

- [ ] **Step 4: Rebuild an index that predates the change**

In `packages/core/src/chat/search.ts`, after `backfillSearchIndex`:

```ts
/**
 * Drops a keyword index built before stemming, so the boot that follows
 * refills it (2026-10-07). `CREATE VIRTUAL TABLE IF NOT EXISTS` cannot change
 * the tokenizer of a table that already exists, and an index half stemmed
 * would answer differently depending on when a message happened to arrive.
 * Refilling 94,215 messages was measured at 1.2 seconds, so this costs one
 * slow boot, once.
 */
export function rebuildSearchIndexIfStale(db: Db): boolean {
  const row = db.$client
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'")
    .get() as { sql: string } | undefined;
  if (!row || row.sql.includes("porter")) return false;
  db.$client.exec("DROP TABLE messages_fts");
  db.$client.exec(
    "CREATE VIRTUAL TABLE messages_fts USING fts5(message_id UNINDEXED, subject, from_name, from_address, body, tokenize='porter unicode61')",
  );
  return true;
}
```

- [ ] **Step 5: Call it at boot, before the backfill**

In `apps/web/lib/core.ts`, replace the `backfillSearchIndex(db);` line:

```ts
    // Mail stored before the keyword index existed is not findable until it
    // is in there, and Ask Celeste searches through it (spec 10c). An index
    // built before stemming is dropped first, so the backfill below rebuilds
    // it the new way (2026-10-07).
    rebuildSearchIndexIfStale(db);
    backfillSearchIndex(db);
```

Add `rebuildSearchIndexIfStale` to the import on line 2, and export it from
`packages/core/src/index.ts` beside `backfillSearchIndex`.

- [ ] **Step 6: Run the tests**

Run: `cd packages/core && pnpm vitest run test/chat/search.test.ts`
Expected: PASS, including the identifier test — porter leaves a token with digits alone.

- [ ] **Step 7: Full suite and typecheck**

Run: `cd packages/core && pnpm vitest run && pnpm typecheck`
Then: `cd apps/web && pnpm vitest run && pnpm typecheck`
Expected: all pass. Existing search tests that assert an exact-word match still hold;
if one breaks because a stemmed word now also matches, that is the feature — update the
test's expectation and say so in the commit.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/db/client.ts packages/core/src/chat/search.ts packages/core/src/index.ts packages/core/test/chat/search.test.ts apps/web/lib/core.ts
git commit -m "One word, however it was spelled"
```

---

### Task 2: Embed for search, email before texts

**Files:**
- Modify: `packages/core/src/projects/classify.ts:164-215` (`embedPending`)
- Test: `packages/core/test/projects/classify.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `embedPending(db, embedder, opts, clock)` where `opts` gains
  `scope?: "projects" | "search"` (default `"projects"`, today's behaviour unchanged)
  and still returns `Promise<{ embedded: number; reembedded: number }>`.

- [ ] **Step 1: Write the failing test**

In `packages/core/test/projects/classify.test.ts`:

```ts
describe("embedPending with scope: search", () => {
  it("embeds mail the projects scope skips, and puts email before texts", async () => {
    const db = testDb();
    const mail = seedAccount(db, { provider: "imap" });
    const texts = seedAccount(db, { provider: "imessage" });
    // Newer than the email, so only the email-first rule can order these.
    seedMessage(db, { id: "t1", accountId: texts, folder: "messages", sentAt: 2000 });
    seedMessage(db, { id: "e1", accountId: mail, folder: "inbox", sentAt: 1000 });
    // The operator's own sent mail, which the projects scope leaves out.
    seedMessage(db, { id: "e2", accountId: mail, folder: "sent", isFromOperator: true, sentAt: 900 });

    const seen: string[] = [];
    const embedder = { embed: async (texts: string[]) => { seen.push(...texts); return texts.map(() => new Float32Array(768)); } };

    const r = await embedPending(db, embedder, { scope: "search", limit: 2 });
    expect(r.embedded).toBe(2);
    // Both email, though the text is the newest message in the mailbox.
    expect(embeddedIds(db)).toEqual(["e1", "e2"]);
  });

  it("leaves junk alone", async () => {
    const db = testDb();
    const mail = seedAccount(db, { provider: "imap" });
    seedMessage(db, { id: "j1", accountId: mail, folder: "junk", sentAt: 3000 });
    const embedder = { embed: async () => [] };
    expect((await embedPending(db, embedder, { scope: "search" })).embedded).toBe(0);
  });

  it("still embeds only the projects scope by default", async () => {
    const db = testDb();
    const mail = seedAccount(db, { provider: "imap" });
    seedMessage(db, { id: "e3", accountId: mail, folder: "inbox", isFromOperator: true, sentAt: 1000 });
    const embedder = { embed: async () => [] };
    expect((await embedPending(db, embedder)).embedded).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/core && pnpm vitest run test/projects/classify.test.ts -t "scope: search"`
Expected: FAIL — `scope` is not a known option, so the default conditions apply and
nothing outside inbox/sent-not-from-operator is embedded.

- [ ] **Step 3: Widen the candidate query**

In `packages/core/src/projects/classify.ts`, replace the `conditions` block inside
`embedPending`:

```ts
  // Two different questions want vectors. Filing a message under a project
  // only ever concerned inbound mail in the folders the operator lives in.
  // Searching by meaning concerns everything they might ask about, their own
  // sent mail and their texts included (operator, 2026-10-07: "everything,
  // email first"), and only junk is never worth the room.
  const forSearch = opts.scope === "search";
  const conditions = forSearch
    ? [ne(messages.folder, "junk")]
    : [eq(messages.isFromOperator, false), inArray(messages.folder, ["inbox", "sent"])];
  if (opts.accountId) conditions.push(eq(messages.accountId, opts.accountId));
```

Change the signature on line 164-168:

```ts
export async function embedPending(
  db: Db,
  embedder: Embedder,
  opts: { accountId?: string; limit?: number; scope?: "projects" | "search" } = {},
  clock: () => number = now,
): Promise<{ embedded: number; reembedded: number }> {
```

- [ ] **Step 4: Order email before texts**

The candidate select currently reads `.orderBy(desc(messages.sentAt))`. Replace it, and
join accounts so the provider is known:

```ts
    .leftJoin(embeddingState, eq(embeddingState.messageId, messages.id))
    .innerJoin(accounts, eq(accounts.id, messages.accountId))
    .where(and(...conditions))
    // Email first, newest first within it (2026-10-07). Their mailbox is
    // 86,210 texts to 7,939 emails, so newest-first alone would spend its
    // first hour on texts while the complaint that started this was about
    // email. Texts follow, and the clock keeps going until there are none.
    .orderBy(
      forSearch ? sql`${accounts.provider} IN ('imessage', 'whatsapp')` : sql`0`,
      desc(messages.sentAt),
    )
```

Add `accounts` to the schema import and `ne` to the drizzle-orm import at the top of the
file.

- [ ] **Step 5: Run the tests**

Run: `cd packages/core && pnpm vitest run test/projects/classify.test.ts`
Expected: PASS, including the existing projects-scope tests, which must be untouched.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/projects/classify.ts packages/core/test/projects/classify.test.ts
git commit -m "Vectors for everything they might ask about"
```

---

### Task 3: Searching by meaning

**Files:**
- Create: `packages/core/src/chat/meaning.ts`
- Test: `packages/core/test/chat/meaning.test.ts`

**Interfaces:**
- Consumes: `SearchFilters`, `SearchHit`, `channelOf` from `packages/core/src/chat/search.ts`;
  `QUERY_PREFIX` from `packages/core/src/projects/classify.ts`; `Embedder` and
  `EmbeddingsUnavailableError` from `packages/core/src/projects/embedder.ts`.
- Produces: `searchByMeaning(db: Db, embedder: Embedder, query: string, opts?: SearchFilters): Promise<SearchHit[]>`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/chat/meaning.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { searchByMeaning } from "../../src/chat/meaning";

/** An embedder that answers with whatever vector the test names, or refuses. */
function embedderOf(vector: Float32Array | Error) {
  return {
    embed: async () => {
      if (vector instanceof Error) throw vector;
      return [vector];
    },
  };
}

describe("searchByMeaning", () => {
  it("returns the nearest messages, nearest first", async () => {
    const db = testDbWithVectors();
    seedEmbedded(db, "near", unit(0));
    seedEmbedded(db, "far", unit(1));
    const hits = await searchByMeaning(db, embedderOf(unit(0)), "anything");
    expect(hits.map((h) => h.messageId)).toEqual(["near", "far"]);
  });

  it("asks as a question, not as a document", async () => {
    const db = testDbWithVectors();
    const seen: string[] = [];
    await searchByMeaning(db, { embed: async (t: string[]) => { seen.push(...t); return [unit(0)]; } }, "where is the invoice");
    expect(seen).toEqual(["search_query: where is the invoice"]);
  });

  it("is empty, never an error, when Ollama is not running", async () => {
    const db = testDbWithVectors();
    await expect(searchByMeaning(db, embedderOf(new EmbeddingsUnavailableError("no ollama")), "invoice")).resolves.toEqual([]);
  });

  it("is empty when the vector extension did not load", async () => {
    const db = testDbWithoutVectors();
    await expect(searchByMeaning(db, embedderOf(unit(0)), "invoice")).resolves.toEqual([]);
  });

  /** An embedding of "???" ranks arbitrary mail highly; better to say nothing. */
  it("does not embed a question with no words in it", async () => {
    const db = testDbWithVectors();
    let asked = false;
    const hits = await searchByMeaning(db, { embed: async () => { asked = true; return [unit(0)]; } }, "???");
    expect(asked).toBe(false);
    expect(hits).toEqual([]);
  });

  it("drops a vector whose message has gone", async () => {
    const db = testDbWithVectors();
    seedEmbedded(db, "ghost", unit(0));
    db.$client.prepare("DELETE FROM messages WHERE id = ?").run("ghost");
    await expect(searchByMeaning(db, embedderOf(unit(0)), "invoice")).resolves.toEqual([]);
  });

  it("keeps the caller's filters", async () => {
    const db = testDbWithVectors();
    seedEmbedded(db, "mine", unit(0), { accountId: "a1" });
    seedEmbedded(db, "theirs", unit(0), { accountId: "a2" });
    const hits = await searchByMeaning(db, embedderOf(unit(0)), "invoice", { accountId: "a1" });
    expect(hits.map((h) => h.messageId)).toEqual(["mine"]);
  });
});
```

Write `testDbWithVectors`, `testDbWithoutVectors`, `seedEmbedded` and `unit(i)` (a
768-float vector with 1 at index `i`) as helpers in the same file, following the shape of
the helpers in `packages/core/test/projects/classify.test.ts`.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/core && pnpm vitest run test/chat/meaning.test.ts`
Expected: FAIL — `../../src/chat/meaning` does not exist.

- [ ] **Step 3: Write it**

Create `packages/core/src/chat/meaning.ts`:

```ts
import type { Db } from "../db/client";
import { EmbeddingsUnavailableError, type Embedder } from "../projects/embedder";
import { QUERY_PREFIX } from "../projects/classify";
import { channelOf, ftsQuery, type SearchFilters } from "./search";
import type { SearchHit } from "./types";

/**
 * How many neighbours to ask the vector table for before the filters cut it
 * down. A question narrowed to one inbox would otherwise come back with eight
 * neighbours and keep two.
 */
const OVERSAMPLE = 6;

/**
 * The other way to find mail (operator, 2026-10-07: "we need to do semantic
 * search, definitely"). The keyword index knows the words a message contains
 * and nothing about what it meant, so a question worded differently from the
 * mail finds nothing and Celeste guesses again. This asks the vectors
 * instead: the question is embedded by the same local model that embedded the
 * mail, and the table answers with what is nearest.
 *
 * It never throws. The vectors may not have loaded, Ollama may not be
 * running, and the operator is still owed whatever the words alone can find.
 */
export async function searchByMeaning(db: Db, embedder: Embedder, query: string, opts: SearchFilters = {}): Promise<SearchHit[]> {
  if (!db.vecAvailable) return [];
  // A question with no words in it has no meaning to match. An embedding of
  // "???" is a direction like any other, and it would rank arbitrary mail
  // highly rather than nothing at all.
  if (!ftsQuery(query, "AND")) return [];

  let vector: Float32Array;
  try {
    // Asked as a question, against mail embedded as documents: the pair of
    // prefixes is what nomic was trained on, and mixing them up quietly costs
    // accuracy rather than failing.
    const [v] = await embedder.embed([`${QUERY_PREFIX}${query}`]);
    if (!v) return [];
    vector = v;
  } catch (err) {
    if (err instanceof EmbeddingsUnavailableError) return [];
    throw err;
  }

  const limit = opts.limit ?? 8;
  let near: { message_id: string }[];
  try {
    near = db.$client
      .prepare("SELECT message_id FROM message_embeddings WHERE embedding MATCH ? AND k = ?")
      .all(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), limit * OVERSAMPLE) as { message_id: string }[];
  } catch {
    return [];
  }
  if (near.length === 0) return [];

  // The rows, in the order the vectors put them: a message deleted since it
  // was embedded simply does not come back, and the filters narrow the rest.
  return hitsFor(db, near.map((r) => r.message_id), opts, limit);
}
```

Export `narrow`, `COLUMNS`, `ACCOUNT` and `toHits` from `search.ts` (they are module-private
today) so a meaning hit is built by the same code as a word hit — `toHits` stays the only
place a `SearchHit` is constructed. Then, in `meaning.ts`:

```ts
/**
 * The rows behind a list of message ids, in the order the vectors put them.
 * The filters are the same ones the keyword half applies, so narrowing a
 * search to one inbox narrows both halves alike; a message deleted since it
 * was embedded has no row and simply does not come back. There is no matched
 * term to centre a snippet on, so it is the opening of the body, as a search
 * with filters and no words already does.
 */
function hitsFor(db: Db, ids: string[], filters: SearchFilters, limit: number): SearchHit[] {
  const { join, where, params } = narrow(filters);
  const holes = ids.map(() => "?").join(", ");
  const bound: (string | number)[] = [...(filters.projectId ? [filters.projectId] : []), ...ids, ...params];
  const rows = db.$client
    .prepare(
      `SELECT ${COLUMNS}, substr(replace(m.body_text, char(10), ' '), 1, 160) AS snippet
       FROM messages m${ACCOUNT}${join}
       WHERE m.id IN (${holes})${where.length > 0 ? ` AND ${where.join(" AND ")}` : ""}`,
    )
    .all(...bound) as SearchRow[];
  const byId = new Map(rows.map((r) => [r.message_id, r]));
  const kept: SearchRow[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) kept.push(row);
    if (kept.length === limit) break;
  }
  return toHits(kept);
}
```

`SearchRow` must be exported from `search.ts` too.

- [ ] **Step 4: Run the tests**

Run: `cd packages/core && pnpm vitest run test/chat/meaning.test.ts`
Expected: PASS, all seven.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/chat/meaning.ts packages/core/src/chat/search.ts packages/core/test/chat/meaning.test.ts
git commit -m "Asking the vectors what the question meant"
```

---

### Task 4: The merge

**Files:**
- Modify: `packages/core/src/chat/search.ts` (add `mergeHits`)
- Test: `packages/core/test/chat/search.test.ts`

**Interfaces:**
- Consumes: `SearchHit`.
- Produces: `mergeHits(words: SearchHit[], meaning: SearchHit[], limit: number): SearchHit[]`.

- [ ] **Step 1: Write the failing test**

```ts
describe("mergeHits", () => {
  const hit = (id: string): SearchHit => ({ messageId: id, threadId: `t-${id}`, subject: id, from: "sam@example.com", sentAt: 0, snippet: "", channel: "mail" });

  it("leads with the best word match, so an identifier is never pushed off", () => {
    const merged = mergeHits([hit("w1"), hit("w2")], [hit("m1"), hit("m2")], 10);
    expect(merged.map((h) => h.messageId)).toEqual(["w1", "m1", "w2", "m2"]);
  });

  it("shows a message found both ways once, at its better place", () => {
    const merged = mergeHits([hit("a")], [hit("a"), hit("b")], 10);
    expect(merged.map((h) => h.messageId)).toEqual(["a", "b"]);
  });

  it("fills from whichever half has more when the other runs out", () => {
    expect(mergeHits([hit("w1")], [hit("m1"), hit("m2"), hit("m3")], 10).map((h) => h.messageId)).toEqual(["w1", "m1", "m2", "m3"]);
    expect(mergeHits([hit("w1"), hit("w2")], [], 10).map((h) => h.messageId)).toEqual(["w1", "w2"]);
  });

  it("never returns more than asked for, and keeps the best of each half within it", () => {
    const merged = mergeHits([hit("w1"), hit("w2"), hit("w3")], [hit("m1"), hit("m2")], 3);
    expect(merged.map((h) => h.messageId)).toEqual(["w1", "m1", "w2"]);
  });

  it("is empty when neither half found anything", () => {
    expect(mergeHits([], [], 10)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/core && pnpm vitest run test/chat/search.test.ts -t mergeHits`
Expected: FAIL — `mergeHits` is not exported.

- [ ] **Step 3: Write it**

In `packages/core/src/chat/search.ts`:

```ts
/**
 * The two halves of a search, as one list (2026-10-07). They answer different
 * questions well: the words find `IOE8022910507`, which is in 71 of the
 * operator's messages and which an embedding model turns to noise, and the
 * meaning finds the mail about billing when the question said invoicing.
 *
 * So they alternate, words first. Whatever the keyword index thought was the
 * best match stays the first thing the operator sees, and a meaning match
 * reaches the list without having to beat it. A message both halves found is
 * one message, at the better of its two places.
 */
export function mergeHits(words: SearchHit[], meaning: SearchHit[], limit: number): SearchHit[] {
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  for (let i = 0; out.length < limit && (i < words.length || i < meaning.length); i++) {
    for (const hit of [words[i], meaning[i]]) {
      if (!hit || seen.has(hit.messageId) || out.length >= limit) continue;
      seen.add(hit.messageId);
      out.push(hit);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/core && pnpm vitest run test/chat/search.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/chat/search.ts packages/core/test/chat/search.test.ts
git commit -m "Both halves of a search, as one list"
```

---

### Task 5: Hybrid search, and Celeste using it

**Files:**
- Modify: `packages/core/src/chat/meaning.ts` (add `searchHybrid`)
- Modify: `packages/core/src/chat/ask.ts:174-179` (`AskDeps`), `:440-470` (the tool loop)
- Modify: `apps/web/app/ask/actions.ts:194` (build the embedder)
- Modify: `packages/core/src/index.ts` (export `searchByMeaning`, `searchHybrid`, `mergeHits`)
- Test: `packages/core/test/chat/meaning.test.ts`, `packages/core/test/chat/ask.test.ts`

**Interfaces:**
- Consumes: `searchByMeaning` (Task 3), `mergeHits` (Task 4), `searchMessages`.
- Produces: `searchHybrid(db: Db, embedder: Embedder | undefined, query: string, opts?: SearchFilters): Promise<SearchHit[]>`;
  `AskDeps.embedder?: Embedder`.

- [ ] **Step 1: Write the failing test**

In `packages/core/test/chat/meaning.test.ts`:

```ts
describe("searchHybrid", () => {
  it("is the keyword search alone when there is no embedder", async () => {
    const db = testDbWithVectors();
    seedIndexed(db, "w1", { body: "the invoice is attached" });
    await expect(searchHybrid(db, undefined, "invoice").then((h) => h.map((x) => x.messageId))).resolves.toEqual(["w1"]);
  });

  it("is the keyword search alone when Ollama is not running", async () => {
    const db = testDbWithVectors();
    seedIndexed(db, "w1", { body: "the invoice is attached" });
    const down = { embed: async () => { throw new EmbeddingsUnavailableError("no ollama"); } };
    await expect(searchHybrid(db, down, "invoice").then((h) => h.map((x) => x.messageId))).resolves.toEqual(["w1"]);
  });

  it("puts a meaning match beside a word match", async () => {
    const db = testDbWithVectors();
    seedIndexed(db, "w1", { body: "the invoice is attached" });
    seedEmbedded(db, "m1", unit(0));
    const hits = await searchHybrid(db, embedderOf(unit(0)), "invoice");
    expect(hits.map((h) => h.messageId)).toEqual(["w1", "m1"]);
  });
});
```

In `packages/core/test/chat/ask.test.ts`, add a test that `search_inbox` returns a
meaning hit when `deps.embedder` is given, following the shape of the existing
`search_inbox` test in that file.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/core && pnpm vitest run test/chat/meaning.test.ts -t searchHybrid`
Expected: FAIL — `searchHybrid` is not exported.

- [ ] **Step 3: Write `searchHybrid`**

In `packages/core/src/chat/meaning.ts`:

```ts
/**
 * What `search_inbox` runs (2026-10-07). Both halves at once, because they
 * take about the same time and neither waits on the other: the words come
 * from an index that answers in under ten milliseconds, the meaning from one
 * embed call of about forty. Without an embedder, or with one that cannot
 * reach Ollama, this is exactly the search Celeste has always had.
 */
export async function searchHybrid(db: Db, embedder: Embedder | undefined, query: string, opts: SearchFilters = {}): Promise<SearchHit[]> {
  const limit = Math.min(opts.limit ?? 8, MAX_SEARCH_LIMIT);
  const words = searchMessages(db, query, opts);
  if (!embedder) return words;
  const meaning = await searchByMeaning(db, embedder, query, opts).catch(() => [] as SearchHit[]);
  if (meaning.length === 0) return words;
  return mergeHits(words, meaning, limit);
}
```

- [ ] **Step 4: Give Celeste the embedder**

In `packages/core/src/chat/ask.ts`, add to `AskDeps`:

```ts
  /**
   * The local embedder, when one is to hand, so a search finds mail that
   * means what was asked and not only mail that says it (2026-10-07). Absent,
   * search is the keyword half alone, which is what it was before.
   */
  embedder?: Embedder;
```

The tool loop at line 440 is `toolUses.map((use) => {…})` and must become
`await Promise.all(toolUses.map(async (use) => {…}))`, with the `search_inbox` branch
awaiting `searchHybrid(db, deps.embedder, …)` in place of `searchMessages(db, …)`. Every
other branch stays synchronous inside the async callback.

In `apps/web/app/ask/actions.ts`, where `askCeleste` is called at line 194, build the
embedder the same way `createLearningSorter` does
(`packages/core/src/models/factory.ts:60`):

```ts
      // The same local embedder the sorter uses, so a question finds mail by
      // what it meant (2026-10-07). Not reaching Ollama costs nothing here:
      // the search falls back to words.
      embedder: createOllamaEmbedder(cfg.ollamaUrl, cfg.embedModel, { db }),
```

- [ ] **Step 5: Run the tests**

Run: `cd packages/core && pnpm vitest run && pnpm typecheck`
Then: `cd apps/web && pnpm vitest run && pnpm typecheck && pnpm build`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/chat/meaning.ts packages/core/src/chat/ask.ts packages/core/src/index.ts apps/web/app/ask/actions.ts packages/core/test/chat/
git commit -m "Celeste searches by meaning as well as by words"
```

---

### Task 6: The clock that fills the backlog

**Files:**
- Create: `apps/web/lib/embedClock.ts`
- Modify: `apps/web/lib/mailClock.ts` (export the ticker handle so the embedder can yield to it)
- Modify: wherever `startMailClock()` is called (`grep -rn "startMailClock" apps/web`)
- Test: `apps/web/test/embedClock.test.ts`

**Interfaces:**
- Consumes: `embedPending` with `scope: "search"` (Task 2); `Ticker` from `@messaging-agent/core`.
- Produces: `startEmbedClock(): void`; `embedBatch(deps): Promise<{ embedded: number; resting: boolean }>` —
  the pure-ish step the test drives, so the test never starts a real timer.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/embedClock.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { embedBatch, EMBED_BATCH, EMBED_EVERY_MS } from "../lib/embedClock";

describe("embedBatch", () => {
  it("embeds a batch and says there is more to do", async () => {
    const embed = vi.fn(async () => ({ embedded: EMBED_BATCH, reembedded: 0 }));
    await expect(embedBatch({ embed, sorting: () => false })).resolves.toEqual({ embedded: EMBED_BATCH, resting: false });
  });

  it("rests once a pass embeds less than a full batch", async () => {
    const embed = vi.fn(async () => ({ embedded: 3, reembedded: 0 }));
    await expect(embedBatch({ embed, sorting: () => false })).resolves.toEqual({ embedded: 3, resting: true });
  });

  /** One local model, and a question they are waiting on beats a backfill they are not. */
  it("does nothing while the sorter has the model", async () => {
    const embed = vi.fn(async () => ({ embedded: 0, reembedded: 0 }));
    await expect(embedBatch({ embed, sorting: () => true })).resolves.toEqual({ embedded: 0, resting: false });
    expect(embed).not.toHaveBeenCalled();
  });

  /** Ollama off for a week must not be a line in the log every minute. */
  it("swallows an error, counts nothing, and says nothing the second time", async () => {
    const embed = vi.fn(async () => { throw new Error("no ollama"); });
    const said: string[] = [];
    const log = (m: string) => said.push(m);
    await expect(embedBatch({ embed, sorting: () => false, log })).resolves.toEqual({ embedded: 0, resting: false });
    await embedBatch({ embed, sorting: () => false, log });
    await embedBatch({ embed, sorting: () => false, log });
    expect(said).toEqual(["embed clock: no ollama"]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && pnpm vitest run test/embedClock.test.ts`
Expected: FAIL — `../lib/embedClock` does not exist.

- [ ] **Step 3: Write it**

Create `apps/web/lib/embedClock.ts`:

```ts
import { Ticker, embedPending, createOllamaEmbedder } from "@messaging-agent/core";
import { core } from "@/lib/core";
import { mailClockBusy } from "@/lib/mailClock";

/** How many messages one pass embeds. 200 is `embedPending`'s own batch. */
export const EMBED_BATCH = 200;

/** How often a pass runs while there is a backlog. */
export const EMBED_EVERY_MS = 60_000;

/** How long the clock rests once there is nothing left to embed. */
export const EMBED_RESTING_MS = 900_000;

/**
 * One pass, with everything it talks to passed in so the test never starts a
 * timer or reaches Ollama. `resting` means the backlog is done: the pass
 * embedded less than a full batch, so the next tick can wait a long time.
 */
export async function embedBatch(deps: {
  embed: () => Promise<{ embedded: number; reembedded: number }>;
  sorting: () => boolean;
  log?: (message: string) => void;
}): Promise<{ embedded: number; resting: boolean }> {
  // The sorter and this share one local model, and the operator is waiting on
  // a sort in a way they are never waiting on a backfill (2026-10-07).
  if (deps.sorting()) return { embedded: 0, resting: false };
  try {
    const { embedded } = await deps.embed();
    quiet = false;
    return { embedded, resting: embedded < EMBED_BATCH };
  } catch (err) {
    // Ollama off for a week is one line, not one a minute.
    if (!quiet) {
      deps.log?.(`embed clock: ${(err as Error).message}`);
      quiet = true;
    }
    return { embedded: 0, resting: false };
  }
}

let quiet = false;
```

Then, below it in the same file:

```ts
const KEY = Symbol.for("celeste.embedClock");

/**
 * The mail the operator might ask about, embedded a batch at a time on the
 * server's own clock (operator, 2026-10-07: everything, email first, in the
 * background). Their mailbox is 94,149 messages at about forty milliseconds
 * each — an hour if it were done in one go, which would hold up the sorter,
 * since both share the one local model. So it is done in two-hundreds, and
 * it gets out of the way whenever mail is being brought in and sorted.
 *
 * Once there is nothing left the clock slows to a quarter-hour, so a mailbox
 * that is fully embedded is not a query a minute for ever. New mail is a
 * handful of messages, and a quarter-hour late to be searchable by meaning is
 * not a wait anybody notices.
 *
 * The handle lives on globalThis so a dev server reloading this module does
 * not start a second clock.
 */
export function startEmbedClock(): void {
  const g = globalThis as unknown as Record<symbol, Ticker | undefined>;
  if (g[KEY]) return;
  const { cfg, db } = core();
  const embedder = createOllamaEmbedder(cfg.ollamaUrl, cfg.embedModel, { db });

  const run = async (): Promise<void> => {
    const { embedded, resting } = await embedBatch({
      embed: () => embedPending(db, embedder, { scope: "search", limit: EMBED_BATCH }),
      sorting: mailClockBusy,
      log: console.log,
    });
    if (embedded > 0) console.log(`embed clock: ${embedded} embedded`);
    // Resting and working are the same job on two different clocks, so the
    // one in flight is swapped rather than left running beside the new one.
    const want = resting ? EMBED_RESTING_MS : EMBED_EVERY_MS;
    if (g[KEY] && every !== want) {
      g[KEY].stop();
      every = want;
      const next = new Ticker(run, { everyMs: want, onError: (err) => console.error(`embed clock: ${(err as Error).message}`) });
      next.start();
      g[KEY] = next;
    }
  };

  let every = EMBED_EVERY_MS;
  const ticker = new Ticker(run, {
    everyMs: EMBED_EVERY_MS,
    // After the mail clock's first fetch, not alongside it.
    firstAfterMs: 30_000,
    onError: (err) => console.error(`embed clock: ${(err as Error).message}`),
  });
  ticker.start();
  g[KEY] = ticker;
  console.log(`embed clock: every ${EMBED_EVERY_MS / 1000}s while there is a backlog`);
}
```

In `apps/web/lib/mailClock.ts`, export the handle's busy state:

```ts
/** Whether the mail clock is mid-run, so the embedder can leave the model to it. */
export function mailClockBusy(): boolean {
  const g = globalThis as unknown as Record<symbol, Ticker | undefined>;
  return g[KEY]?.running ?? false;
}
```

Call `startEmbedClock()` wherever `startMailClock()` is called.

- [ ] **Step 4: Run the tests**

Run: `cd apps/web && pnpm vitest run test/embedClock.test.ts`
Expected: PASS, all four. Reset the module between tests (`vi.resetModules()`) so the
`quiet` flag does not leak between them.

- [ ] **Step 5: Run everything**

Run: `cd apps/web && pnpm vitest run && pnpm typecheck && pnpm build`
Then: `cd packages/core && pnpm vitest run && pnpm typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/lib/embedClock.ts apps/web/lib/mailClock.ts apps/web/test/embedClock.test.ts
git commit -m "The backlog fills itself, and gets out of the sorter's way"
```

---

### Task 7: The diagram, and seeing it work

**Files:**
- Modify: `docs/diagrams/system-architecture.json`
- Modify: `docs/diagrams/system-architecture.html` (rendered, not hand-edited)

- [ ] **Step 1: Add what is new to the diagram**

The embed clock is a new runtime process beside the mail clock, and the search path now
reads `message_embeddings` as well as `messages_fts`. Add both to
`docs/diagrams/system-architecture.json`, then render:

```bash
node ~/.claude/skills/archify/bin/archify.mjs deliver architecture docs/diagrams/system-architecture.json docs/diagrams/system-architecture.html --quality showcase --json
```

- [ ] **Step 2: Measure it against a copy of the real mailbox**

Copy the operator's database to the scratchpad (never work against `~/messaging-agent`),
run a dev server on port 3112 with `MESSAGING_AGENT_DATA_DIR` pointed at the copy, and
check three things, recording the numbers:

1. Boot drops and refills the keyword index, and the log says how long it took
   (expected: about 1.2 seconds for 94,215 messages).
2. `invoice`, `invoices` and `invoicing` return the same count.
3. The embed clock embeds email before texts: after the first pass, every embedded
   message's account is a mail provider.

- [ ] **Step 3: Commit**

```bash
git add docs/diagrams/system-architecture.json docs/diagrams/system-architecture.html
git commit -m "The clock that fills the vectors, on the diagram"
```
