import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../helpers/db";
import { appendChatMessage, findChatFor, getOrCreateChat, listChats, openChatFor, startNewChat } from "../../src/chat/store";
import { chats } from "../../src/db/schema";
import { seedMail } from "./seed";

function clockFrom(start: number): () => number {
  let t = start;
  return () => t++;
}

describe("openChatFor", () => {
  it("makes a thread's conversation once and comes back to it", () => {
    const db = testDb();
    seedMail(db, [{ id: "m1", subject: "March invoice" }]);
    const first = openChatFor(db, { threadId: "a1:t-m1" }, clockFrom(1000));
    const again = openChatFor(db, { threadId: "a1:t-m1" }, clockFrom(2000));
    expect(again.id).toBe(first.id);
    expect(again.kind).toBe("thread");
    expect(again.threadId).toBe("a1:t-m1");
    expect(db.select().from(chats).all()).toHaveLength(1);
  });

  it("names it after the thread's subject and who it is with", () => {
    const db = testDb();
    seedMail(db, [{ id: "m1", subject: "March invoice", fromName: "Bob Vance", fromAddress: "bob@example.com" }]);
    expect(openChatFor(db, { threadId: "a1:t-m1" }, clockFrom(1000)).title).toBe("March invoice · Bob Vance");
  });

  it("keeps the general conversation apart from a thread's", () => {
    const db = testDb();
    seedMail(db, [{ id: "m1", subject: "March invoice" }]);
    const general = openChatFor(db, {}, clockFrom(1000));
    const thread = openChatFor(db, { threadId: "a1:t-m1" }, clockFrom(2000));
    expect(general.kind).toBe("general");
    expect(general.title).toBe("General");
    expect(general.threadId).toBeNull();
    expect(thread.id).not.toBe(general.id);
    // The one chat the rest of the app already asks for is the general one.
    expect(getOrCreateChat(db).id).toBe(general.id);
  });
});

describe("findChatFor", () => {
  it("finds nothing, and makes nothing, for a thread never asked about", () => {
    const db = testDb();
    seedMail(db, [{ id: "m1", subject: "March invoice" }]);
    expect(findChatFor(db, { threadId: "a1:t-m1" })).toBeUndefined();
    expect(db.select().from(chats).all()).toEqual([]);
  });
});

describe("startNewChat", () => {
  it("closes the one that was open and opens a fresh one", () => {
    const db = testDb();
    seedMail(db, [{ id: "m1", subject: "March invoice" }]);
    const clock = clockFrom(1000);
    const first = openChatFor(db, { threadId: "a1:t-m1" }, clock);
    appendChatMessage(db, { chatId: first.id, role: "user", content: "hello" }, clock);

    const fresh = startNewChat(db, { threadId: "a1:t-m1" }, clock);
    expect(fresh.id).not.toBe(first.id);
    expect(db.select().from(chats).where(eq(chats.id, first.id)).get()!.closedAt).not.toBeNull();
    // Opening the thread again lands on the fresh one, and the old one stays.
    expect(openChatFor(db, { threadId: "a1:t-m1" }, clock).id).toBe(fresh.id);
    expect(db.select().from(chats).all()).toHaveLength(2);
  });
});

describe("listChats", () => {
  it("puts the conversation spoken to last on top, with its counts", () => {
    const db = testDb();
    seedMail(db, [{ id: "m1", subject: "March invoice" }]);
    const clock = clockFrom(1000);
    const general = openChatFor(db, {}, clock);
    const thread = openChatFor(db, { threadId: "a1:t-m1" }, clock);
    appendChatMessage(db, { chatId: general.id, role: "user", content: "hi" }, clock);
    appendChatMessage(db, { chatId: thread.id, role: "user", content: "what is this" }, clock);
    const lastAt = appendChatMessage(db, { chatId: thread.id, role: "assistant", content: "an invoice" }, clock).createdAt;

    const list = listChats(db);
    expect(list.map((c) => c.id)).toEqual([thread.id, general.id]);
    expect(list[0]!.messageCount).toBe(2);
    expect(list[0]!.lastAt).toBe(lastAt);
    expect(list[1]!.messageCount).toBe(1);
  });

  it("carries the first thing asked, which is what a General conversation is about", () => {
    const db = testDb();
    const clock = clockFrom(1000);
    const general = openChatFor(db, {}, clock);
    appendChatMessage(db, { chatId: general.id, role: "user", content: "why did Pear pass on us" }, clock);
    appendChatMessage(db, { chatId: general.id, role: "assistant", content: "they said timing" }, clock);
    appendChatMessage(db, { chatId: general.id, role: "user", content: "and the second question" }, clock);

    expect(listChats(db)[0]!.firstQuestion).toBe("why did Pear pass on us");
  });

  it("has no question to show for a conversation only Celeste has spoken in", () => {
    const db = testDb();
    const clock = clockFrom(1000);
    const general = openChatFor(db, {}, clock);
    appendChatMessage(db, { chatId: general.id, role: "assistant", content: "anything I can do?" }, clock);

    expect(listChats(db)[0]!.firstQuestion).toBeNull();
  });

  it("shows a closed conversation too, so History can go back to it", () => {
    const db = testDb();
    const clock = clockFrom(1000);
    const first = openChatFor(db, {}, clock);
    appendChatMessage(db, { chatId: first.id, role: "user", content: "hi" }, clock);
    startNewChat(db, {}, clock);
    expect(listChats(db).map((c) => c.id)).toContain(first.id);
  });

  it("leaves out a conversation nothing was ever said in", () => {
    const db = testDb();
    seedMail(db, [{ id: "m1", subject: "March invoice" }]);
    const clock = clockFrom(1000);
    openChatFor(db, { threadId: "a1:t-m1" }, clock);
    expect(listChats(db)).toEqual([]);
  });
});

describe("the 0020 migration", () => {
  it("turns the one chat the operator already had into General", () => {
    const sqlite = new Database(":memory:");
    // The `chats` table as it stood before conversations were per thread.
    sqlite.exec("CREATE TABLE `chats` (`id` text PRIMARY KEY NOT NULL, `created_at` integer NOT NULL)");
    sqlite.prepare("INSERT INTO chats (id, created_at) VALUES (?, ?)").run("operator", 1_700_000_000_000);

    const migration = readFileSync(new URL("../../drizzle/0020_parallel_cassandra_nova.sql", import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) sqlite.exec(statement);

    const row = sqlite.prepare("SELECT * FROM chats WHERE id = 'operator'").get() as Record<string, unknown>;
    expect(row.kind).toBe("general");
    expect(row.title).toBe("General");
    expect(row.thread_id).toBeNull();
    expect(row.updated_at).toBe(1_700_000_000_000);
    expect(row.closed_at).toBeNull();
  });
});

describe("deleteChat", () => {
  it("removes the conversation with its turns, and the context opens a fresh one after", async () => {
    const { deleteChat, openChatFor, appendChatMessage, listChatMessages, listChats } = await import("../../src/chat/store");
    const db = testDb();
    const chat = openChatFor(db, {}, () => 5);
    appendChatMessage(db, { chatId: chat.id, role: "user", content: "hi", contextThreadId: null, citations: [], actions: [], model: null, inputTokens: 0, outputTokens: 0 }, () => 6);
    expect(listChatMessages(db, chat.id)).toHaveLength(1);
    expect(deleteChat(db, chat.id)).toBe(true);
    expect(listChatMessages(db, chat.id)).toHaveLength(0);
    expect(listChats(db).some((c) => c.id === chat.id)).toBe(false);
    expect(openChatFor(db, {}, () => 7).id).not.toBe(chat.id);
    expect(deleteChat(db, chat.id)).toBe(false);
  });
});
