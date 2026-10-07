import { describe, it, expect } from "vitest";
import { testDb } from "../helpers/db";
import { EmbeddingsUnavailableError, type Embedder } from "../../src/projects/embedder";
import { EMBEDDING_DIMENSIONS, type Db } from "../../src/db/client";
import { accounts, messages, threads } from "../../src/db/schema";
import { searchByMeaning } from "../../src/chat/meaning";

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
});
