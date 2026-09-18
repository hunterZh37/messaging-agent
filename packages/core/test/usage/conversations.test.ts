import { describe, it, expect } from "vitest";
import type { Db } from "../../src/db/client";
import { chatMessages, chats, modelCalls } from "../../src/db/schema";
import { conversationUsage, usageByConversation } from "../../src/usage/conversations";
import { testDb } from "../helpers/db";

const NOON = Date.UTC(2026, 8, 10, 12);
const DAY = 86_400_000;

function chat(db: Db, id: string, title: string, at = NOON): void {
  db.insert(chats).values({ id, kind: "general", threadId: null, title, createdAt: at, updatedAt: at }).run();
}

/** One question from the operator. */
function question(db: Db, id: string, chatId: string, at: number, content: string): void {
  db.insert(chatMessages).values({ id, chatId, role: "user", content, createdAt: at }).run();
}

/** One assistant turn, as `askCeleste` writes it. */
function turn(db: Db, id: string, chatId: string, at: number, tokens: { model?: string | null; input?: number; output?: number } = {}): void {
  db.insert(chatMessages)
    .values({
      id,
      chatId,
      role: "assistant",
      content: "here you go",
      model: tokens.model === undefined ? "anthropic:claude-sonnet-5" : tokens.model,
      inputTokens: tokens.input ?? null,
      outputTokens: tokens.output ?? null,
      createdAt: at,
    })
    .run();
}

/** One request the tool loop sent, as the ledger writes it. */
function call(db: Db, id: string, chatId: string | null, at: number, row: Partial<typeof modelCalls.$inferInsert> = {}): void {
  db.insert(modelCalls)
    .values({
      id,
      at,
      role: "chat",
      provider: "anthropic",
      model: "claude-sonnet-5",
      kind: "chat",
      inputTokens: 1000,
      outputTokens: 100,
      latencyMs: 900,
      costUsd: 0.0045,
      ref: chatId,
      ...row,
    })
    .run();
}

describe("conversationUsage", () => {
  it("adds up every request the tool loop sent for that conversation", () => {
    const db = testDb();
    chat(db, "chat-1", "General");
    turn(db, "t1", "chat-1", NOON);
    call(db, "c1", "chat-1", NOON, { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 8000, costUsd: 0.01 });
    call(db, "c2", "chat-1", NOON + 1000, { inputTokens: 200, outputTokens: 50, cacheWriteTokens: 400, costUsd: 0.02 });

    expect(conversationUsage(db, "chat-1")).toMatchObject({
      chatId: "chat-1",
      title: "General",
      turns: 1,
      inputTokens: 1200,
      outputTokens: 150,
      cacheReadTokens: 8000,
      cacheWriteTokens: 400,
      estimated: false,
    });
    expect(conversationUsage(db, "chat-1").costUsd).toBeCloseTo(0.03, 10);
  });

  it("counts the answers, not the requests behind them", () => {
    const db = testDb();
    chat(db, "chat-1", "General");
    turn(db, "t1", "chat-1", NOON);
    turn(db, "t2", "chat-1", NOON + 5000);
    // Two questions, five requests: a tool loop asks more than once per answer.
    for (const i of [1, 2, 3, 4, 5]) call(db, `c${i}`, "chat-1", NOON + i);

    expect(conversationUsage(db, "chat-1").turns).toBe(2);
  });

  it("leaves another conversation's spending alone", () => {
    const db = testDb();
    chat(db, "chat-1", "General");
    chat(db, "chat-2", "Visa timeline · Victoria Chen");
    call(db, "c1", "chat-1", NOON, { costUsd: 0.01 });
    call(db, "c2", "chat-2", NOON, { costUsd: 0.09 });

    expect(conversationUsage(db, "chat-1").costUsd).toBeCloseTo(0.01, 10);
    expect(conversationUsage(db, "chat-2").costUsd).toBeCloseTo(0.09, 10);
  });

  it("reads an old conversation off its stored turns rather than calling it free", () => {
    const db = testDb();
    chat(db, "chat-old", "Before the ledger");
    turn(db, "t1", "chat-old", NOON - 30 * DAY, { input: 1_000_000, output: 100_000 });
    turn(db, "t2", "chat-old", NOON - 29 * DAY, { input: 0, output: 0 });

    const usage = conversationUsage(db, "chat-old");
    expect(usage).toMatchObject({ turns: 2, inputTokens: 1_000_000, outputTokens: 100_000, estimated: true });
    // Sonnet: $3 per million in, $15 per million out.
    expect(usage.costUsd).toBeCloseTo(3 + 1.5, 10);
  });

  it("says nothing at all about a conversation nobody has asked anything in", () => {
    const db = testDb();
    chat(db, "chat-1", "General");
    expect(conversationUsage(db, "chat-1")).toMatchObject({ turns: 0, costUsd: 0, lastAt: null, estimated: false });
  });

  it("prefers the ledger when a conversation has both", () => {
    const db = testDb();
    chat(db, "chat-1", "General");
    turn(db, "t1", "chat-1", NOON, { input: 999_999, output: 999_999 });
    call(db, "c1", "chat-1", NOON, { inputTokens: 10, outputTokens: 2, costUsd: 0.5 });

    expect(conversationUsage(db, "chat-1")).toMatchObject({ inputTokens: 10, outputTokens: 2, costUsd: 0.5, estimated: false });
  });
});

describe("what a conversation is about", () => {
  it("carries the opening question, so a General row is not just General", () => {
    const db = testDb();
    chat(db, "chat-1", "General");
    question(db, "q1", "chat-1", NOON, "why did Pear pass on us");
    question(db, "q2", "chat-1", NOON + 10, "and who else passed");
    call(db, "c1", "chat-1", NOON);

    expect(conversationUsage(db, "chat-1").firstQuestion).toBe("why did Pear pass on us");
    expect(usageByConversation(db)[0]?.firstQuestion).toBe("why did Pear pass on us");
  });

  it("has none for a conversation nobody has asked anything in", () => {
    const db = testDb();
    chat(db, "chat-1", "General");
    expect(conversationUsage(db, "chat-1").firstQuestion).toBeNull();
  });
});

describe("usageByConversation", () => {
  it("lists every conversation with something to report, newest first", () => {
    const db = testDb();
    chat(db, "chat-1", "General");
    chat(db, "chat-2", "Visa timeline");
    chat(db, "chat-3", "Never used");
    call(db, "c1", "chat-1", NOON - DAY);
    call(db, "c2", "chat-2", NOON);

    const rows = usageByConversation(db);
    expect(rows.map((r) => r.chatId)).toEqual(["chat-2", "chat-1"]);
    expect(rows.map((r) => r.title)).toEqual(["Visa timeline", "General"]);
  });

  it("keeps only what falls inside the window, from either source", () => {
    const db = testDb();
    chat(db, "chat-1", "Recent");
    chat(db, "chat-2", "Older");
    call(db, "c1", "chat-1", NOON);
    turn(db, "t1", "chat-2", NOON - 40 * DAY, { input: 10, output: 1 });

    expect(usageByConversation(db, { since: NOON - 7 * DAY }).map((r) => r.chatId)).toEqual(["chat-1"]);
    expect(usageByConversation(db).map((r) => r.chatId).sort()).toEqual(["chat-1", "chat-2"]);
  });

  it("ignores a ledger row that names no conversation", () => {
    const db = testDb();
    chat(db, "chat-1", "General");
    call(db, "c1", null, NOON);
    call(db, "c2", "chat-1", NOON);

    expect(usageByConversation(db).map((r) => r.chatId)).toEqual(["chat-1"]);
  });

  it("marks the old conversations so the page can say where their figures came from", () => {
    const db = testDb();
    chat(db, "chat-1", "Logged");
    chat(db, "chat-2", "Estimated");
    call(db, "c1", "chat-1", NOON);
    turn(db, "t1", "chat-2", NOON - 1000, { input: 100, output: 10 });

    const rows = usageByConversation(db);
    expect(rows.map((r) => r.estimated)).toEqual([false, true]);
  });
});
