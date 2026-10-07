import { describe, it, expect } from "vitest";
import { testDb } from "../helpers/db";
import { EmbeddingsUnavailableError, type Embedder } from "../../src/projects/embedder";
import { EMBEDDING_DIMENSIONS, type Db } from "../../src/db/client";
import { accounts, messages, threads } from "../../src/db/schema";
import { indexMessageForSearch, MAX_SEARCH_LIMIT } from "../../src/chat/search";
import { searchByMeaning, searchHybrid } from "../../src/chat/meaning";

/** An embedder that answers with whatever vector the test names, or refuses. */
function embedderOf(vector: Float32Array | Error): Embedder {
  return {
    embed: async () => {
      if (vector instanceof Error) throw vector;
      return [vector];
    },
  };
}

/** A unit vector with 1 at index `i` and nothing elsewhere: cosine distance then says exactly how far apart two of these are. */
function unit(i: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIMENSIONS);
  v[i] = 1;
  return v;
}

/** `testDb` already loads sqlite-vec; named to say what the vectors tests lean on. */
function testDbWithVectors(): Db {
  return testDb();
}

/** The extension never loaded, as it does not on a machine without it (2026-10-07). */
function testDbWithoutVectors(): Db {
  const db = testDb();
  db.vecAvailable = false;
  return db;
}

function toBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/** A message with a vector already in `message_embeddings`, as `embedPending` would have left it. */
function seedEmbedded(db: Db, id: string, vector: Float32Array, opts: { accountId?: string } = {}): void {
  const accountId = opts.accountId ?? "a1";
  db.insert(accounts)
    .values({ id: accountId, provider: "imap", email: `${accountId}@example.com`, displayName: null, createdAt: 1 })
    .onConflictDoNothing()
    .run();
  const threadId = `${accountId}:t-${id}`;
  db.insert(threads)
    .values({ id: threadId, accountId, providerThreadId: threadId, subject: "Subject", lastMessageAt: 1000, lastFromOperator: false })
    .onConflictDoNothing()
    .run();
  db.insert(messages)
    .values({
      id,
      accountId,
      providerMessageId: id,
      threadId,
      rfcMessageId: null,
      fromAddress: "bob@example.com",
      fromName: "Bob",
      toAddresses: ["me@example.com"],
      ccAddresses: [],
      subject: "Subject",
      bodyText: "body",
      bodyHtml: null,
      snippet: null,
      attachmentNames: [],
      isFromOperator: false,
      folder: "inbox",
      sentAt: 1000,
      receivedAt: 1000,
    })
    .run();
  db.$client.prepare("INSERT INTO message_embeddings(message_id, embedding) VALUES (?, ?)").run(id, toBuffer(vector));
}

/** A message in the keyword index, as `indexMessageForSearch` would have left it: the word half of a hybrid search. */
function seedIndexed(db: Db, id: string, opts: { body?: string; accountId?: string } = {}): void {
  const accountId = opts.accountId ?? "a1";
  db.insert(accounts)
    .values({ id: accountId, provider: "imap", email: `${accountId}@example.com`, displayName: null, createdAt: 1 })
    .onConflictDoNothing()
    .run();
  const threadId = `${accountId}:t-${id}`;
  db.insert(threads)
    .values({ id: threadId, accountId, providerThreadId: threadId, subject: "Subject", lastMessageAt: 1000, lastFromOperator: false })
    .onConflictDoNothing()
    .run();
  const row = {
    id,
    accountId,
    providerMessageId: id,
    threadId,
    rfcMessageId: null,
    fromAddress: "bob@example.com",
    fromName: "Bob",
    toAddresses: ["me@example.com"],
    ccAddresses: [],
    subject: "Subject",
    bodyText: opts.body ?? "body",
    bodyHtml: null,
    snippet: null,
    attachmentNames: [],
    isFromOperator: false,
    folder: "inbox" as const,
    sentAt: 1000,
    receivedAt: 1000,
  };
  db.insert(messages).values(row).run();
  indexMessageForSearch(db, row);
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
    await searchByMeaning(
      db,
      {
        embed: async (t: string[]) => {
          seen.push(...t);
          return [unit(0)];
        },
      },
      "where is the invoice",
    );
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
    const hits = await searchByMeaning(
      db,
      {
        embed: async () => {
          asked = true;
          return [unit(0)];
        },
      },
      "???",
    );
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

  // 2026-10-07: an unclamped limit here once meant `limit * OVERSAMPLE` bound
  // parameters in the filtered query below -- caller-controlled, same field
  // `searchMessages` already caps at MAX_SEARCH_LIMIT.
  it("caps a caller's limit the same way the keyword half does", async () => {
    const db = testDbWithVectors();
    for (let i = 0; i < MAX_SEARCH_LIMIT + 5; i++) seedEmbedded(db, `m${i}`, unit(0));
    const hits = await searchByMeaning(db, embedderOf(unit(0)), "invoice", { limit: 10_000 });
    expect(hits.length).toBe(MAX_SEARCH_LIMIT);
  });

  it("comes back empty, not thrown, when the filtered query itself fails", async () => {
    const db = testDbWithVectors();
    seedEmbedded(db, "near", unit(0));
    // Whatever breaks the filtered query -- here, a schema missing a table it
    // joins against -- is a miss, not a crash, the same rule `searchMessages`
    // already keeps for a query the index refuses. Foreign keys are off
    // first, or SQLite refuses to drop a table `messages` still points at.
    db.$client.exec("PRAGMA foreign_keys = OFF");
    db.$client.exec("DROP TABLE accounts");
    await expect(searchByMeaning(db, embedderOf(unit(0)), "invoice")).resolves.toEqual([]);
  });
});

describe("searchHybrid", () => {
  it("is the keyword search alone when there is no embedder", async () => {
    const db = testDbWithVectors();
    seedIndexed(db, "w1", { body: "the invoice is attached" });
    await expect(searchHybrid(db, undefined, "invoice").then((h) => h.map((x) => x.messageId))).resolves.toEqual(["w1"]);
  });

  it("is the keyword search alone when Ollama is not running", async () => {
    const db = testDbWithVectors();
    seedIndexed(db, "w1", { body: "the invoice is attached" });
    const down = {
      embed: async () => {
        throw new EmbeddingsUnavailableError("no ollama");
      },
    };
    await expect(searchHybrid(db, down, "invoice").then((h) => h.map((x) => x.messageId))).resolves.toEqual(["w1"]);
  });

  it("puts a meaning match beside a word match", async () => {
    const db = testDbWithVectors();
    seedIndexed(db, "w1", { body: "the invoice is attached" });
    seedEmbedded(db, "m1", unit(0));
    const hits = await searchHybrid(db, embedderOf(unit(0)), "invoice");
    expect(hits.map((h) => h.messageId)).toEqual(["w1", "m1"]);
  });

  /**
   * The third way the meaning half can be absent (2026-10-07): an embedder
   * was given and Ollama answers, but the extension itself never loaded
   * (`searchByMeaning` returns `[]` for this one at its very first line).
   * The other two -- no embedder, and an embedder that throws -- are above;
   * all three are composition, not asserted by `searchHybrid` itself, and
   * all three are owed their own test so nothing downstream of
   * `db.vecAvailable` can silently stop returning the words alone.
   */
  it("is the keyword search alone when the vector extension did not load", async () => {
    const db = testDbWithoutVectors();
    seedIndexed(db, "w1", { body: "the invoice is attached" });
    await expect(searchHybrid(db, embedderOf(unit(0)), "invoice").then((h) => h.map((x) => x.messageId))).resolves.toEqual(["w1"]);
  });
});
