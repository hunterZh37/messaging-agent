import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "./helpers/db";
import { accounts, messages, actions, drafts } from "../src/db/schema";

describe("db", () => {
  it("migrates and round-trips an account", () => {
    const db = testDb();
    db.insert(accounts).values({ id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: 1 }).run();
    const rows = db.select().from(accounts).where(eq(accounts.id, "a1")).all();
    expect(rows[0]?.email).toBe("me@example.com");
  });

  it("stores json arrays and booleans on messages", () => {
    const db = testDb();
    db.insert(accounts).values({ id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: 1 }).run();
    db.insert(messages).values({
      id: "a1:m1", accountId: "a1", providerMessageId: "m1", threadId: "a1:t1", rfcMessageId: "<x@y>",
      fromAddress: "bob@example.com", fromName: "Bob", toAddresses: ["me@example.com"], ccAddresses: [],
      subject: "Hi", bodyText: "hello", snippet: "hello", attachmentNames: ["a.pdf"],
      isFromOperator: false, sentAt: 100, receivedAt: 101,
    }).run();
    const row = db.select().from(messages).where(eq(messages.id, "a1:m1")).get();
    expect(row?.toAddresses).toEqual(["me@example.com"]);
    expect(row?.attachmentNames).toEqual(["a.pdf"]);
    expect(row?.isFromOperator).toBe(false);
  });

  it("loads sqlite-vec and creates the 768-dimension vector table", () => {
    const db = testDb();
    expect(db.vecAvailable).toBe(true);
    const vector = Buffer.from(new Float32Array(768).fill(0.1).buffer);
    db.$client.prepare("INSERT INTO message_embeddings(message_id, embedding) VALUES (?, ?)").run("a1:m1", vector);
    const row = db.$client.prepare("SELECT message_id FROM message_embeddings WHERE message_id = ?").get("a1:m1");
    expect(row).toEqual({ message_id: "a1:m1" });
  });

  it("autoincrements action ids", () => {
    const db = testDb();
    db.insert(actions).values({ kind: "skip", draftId: null, messageId: null, payload: {}, createdAt: 1 }).run();
    db.insert(actions).values({ kind: "skip", draftId: null, messageId: null, payload: {}, createdAt: 2 }).run();
    const rows = db.select().from(actions).all();
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
  });

  /**
   * Migration 0040_compose: thread_id and reply_to_message_id on drafts
   * became nullable, and account_id/subject were added, so a composed
   * message (2026-09-22) can be stored with no thread and nothing it
   * replies to. Goes through the ordinary openDb path, not a hand-rolled
   * schema, so this fails if the migration is ever reverted or skipped.
   */
  it("lets a composed draft's thread_id and reply_to_message_id be null", () => {
    const db = testDb();
    db.insert(accounts).values({ id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: 1 }).run();
    db.insert(drafts).values({
      id: "d1",
      threadId: null,
      replyToMessageId: null,
      accountId: "a1",
      subject: "Hello",
      originalText: "Hi Bob.",
      finalText: null,
      toAddresses: ["bob@x.com"],
      ccAddresses: [],
      status: "pending",
      mode: "new",
      model: "operator",
      sentProviderMessageId: null,
      error: null,
      createdAt: 1,
      updatedAt: 1,
    }).run();
    const row = db.select().from(drafts).where(eq(drafts.id, "d1")).get();
    expect(row).toMatchObject({ threadId: null, replyToMessageId: null, accountId: "a1", subject: "Hello", mode: "new" });
  });
});
