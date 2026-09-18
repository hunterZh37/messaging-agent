import { describe, it, expect } from "vitest";
import { testDb } from "../helpers/db";
import { accounts, messages, threads } from "../../src/db/schema";
import { buildDraftContext, computeRecipients, renderDraftUserMessage } from "../../src/draft/context";

function seed(db: ReturnType<typeof testDb>) {
  db.insert(accounts).values({ id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: 1 }).run();
  db.insert(threads).values([
    { id: "a1:t1", accountId: "a1", providerThreadId: "t1", subject: "Lunch", lastMessageAt: 500, lastFromOperator: false },
    { id: "a1:t2", accountId: "a1", providerThreadId: "t2", subject: "Other", lastMessageAt: 50, lastFromOperator: true },
  ]).run();
  const base = { accountId: "a1", rfcMessageId: null, ccAddresses: [], snippet: null, attachmentNames: [], receivedAt: 1 };
  const rows = [];
  for (let i = 1; i <= 12; i++) {
    rows.push({ ...base, id: `a1:t1m${i}`, providerMessageId: `t1m${i}`, threadId: "a1:t1", fromAddress: i % 2 ? "bob@example.com" : "me@example.com", fromName: i % 2 ? "Bob" : null, toAddresses: i % 2 ? ["me@example.com", "carol@example.com"] : ["bob@example.com"], subject: "Lunch", bodyText: `msg ${i}`, isFromOperator: i % 2 === 0, sentAt: i * 40 });
  }
  rows.push({ ...base, id: "a1:t2m1", providerMessageId: "t2m1", threadId: "a1:t2", fromAddress: "me@example.com", fromName: null, toAddresses: ["zed@example.com"], subject: "Other", bodyText: "to zed", isFromOperator: true, sentAt: 50 });
  db.insert(messages).values(rows).run();
}

describe("buildDraftContext", () => {
  it("returns last 10 thread messages ascending, sent-to-sender, and global sent", () => {
    const db = testDb();
    seed(db);
    const ctx = buildDraftContext(db, "a1:t1m11");
    expect(ctx.operatorEmail).toBe("me@example.com");
    expect(ctx.replyTo.id).toBe("a1:t1m11");
    expect(ctx.thread).toHaveLength(10);
    expect(ctx.thread[0]?.id).toBe("a1:t1m3");
    expect(ctx.thread[9]?.id).toBe("a1:t1m12");
    expect(ctx.sentToSender.every((m) => m.isFromOperator && m.toAddresses.includes("bob@example.com"))).toBe(true);
    expect(ctx.sentToSender).toHaveLength(5);
    expect(ctx.sentGlobal).toHaveLength(7);
    expect(ctx.sentGlobal.some((m) => m.id === "a1:t2m1")).toBe(true);
  });
});

describe("computeRecipients", () => {
  it("replies to all, dropping the operator", () => {
    const r = computeRecipients(
      { fromAddress: "bob@example.com", toAddresses: ["me@example.com", "carol@example.com"], ccAddresses: ["dave@example.com", "ME@example.com"] } as never,
      "me@example.com",
    );
    expect(r).toEqual({ to: ["bob@example.com", "carol@example.com"], cc: ["dave@example.com"] });
  });
});

describe("renderDraftUserMessage", () => {
  it("labels operator messages and includes samples", () => {
    const db = testDb();
    seed(db);
    const s = renderDraftUserMessage(buildDraftContext(db, "a1:t1m11"));
    expect(s).toContain("## Thread (oldest first)");
    expect(s).toContain("[operator] me@example.com");
    expect(s).toContain("## Replies the operator sent to this sender");
    expect(s).toContain("## Recent replies the operator sent to anyone");
    expect(s).toContain("## Reply to this message");
  });
});

describe("buildDraftContext sentToSender", () => {
  it("includes operator messages that cc the sender, not only ones that address them directly", () => {
    const db = testDb();
    db.insert(accounts).values({ id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: 1 }).run();
    db.insert(threads).values({ id: "a1:t1", accountId: "a1", providerThreadId: "t1", subject: "S", lastMessageAt: 100, lastFromOperator: false }).run();
    const base = { accountId: "a1", rfcMessageId: null, snippet: null, attachmentNames: [], receivedAt: 1, threadId: "a1:t1", subject: "S" };
    db.insert(messages).values([
      { ...base, id: "a1:t1m1", providerMessageId: "t1m1", fromAddress: "bob@example.com", fromName: "Bob", toAddresses: ["me@example.com"], ccAddresses: [], bodyText: "hi", isFromOperator: false, sentAt: 50 },
      { ...base, id: "a1:t1m2", providerMessageId: "t1m2", fromAddress: "me@example.com", fromName: null, toAddresses: ["carol@example.com"], ccAddresses: ["bob@example.com"], bodyText: "cc reply", isFromOperator: true, sentAt: 60 },
    ]).run();
    const ctx = buildDraftContext(db, "a1:t1m1");
    expect(ctx.sentToSender.map((m) => m.id)).toEqual(["a1:t1m2"]);
  });

  it("escapes LIKE wildcards in the sender address", () => {
    const db = testDb();
    db.insert(accounts).values({ id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: 1 }).run();
    db.insert(threads).values({ id: "a1:t1", accountId: "a1", providerThreadId: "t1", subject: "S", lastMessageAt: 100, lastFromOperator: false }).run();
    const base = { accountId: "a1", rfcMessageId: null, snippet: null, attachmentNames: [], receivedAt: 1, threadId: "a1:t1", subject: "S", ccAddresses: [] };
    db.insert(messages).values([
      { ...base, id: "a1:t1m1", providerMessageId: "t1m1", fromAddress: "b_ob@example.com", fromName: "Bob", toAddresses: ["me@example.com"], bodyText: "hi", isFromOperator: false, sentAt: 50 },
      { ...base, id: "a1:t1m2", providerMessageId: "t1m2", fromAddress: "me@example.com", fromName: null, toAddresses: ["bxob@example.com"], bodyText: "wrong recipient", isFromOperator: true, sentAt: 60 },
    ]).run();

    expect(buildDraftContext(db, "a1:t1m1").sentToSender).toHaveLength(0);

    db.insert(messages)
      .values({ ...base, id: "a1:t1m3", providerMessageId: "t1m3", fromAddress: "me@example.com", fromName: null, toAddresses: ["b_ob@example.com"], bodyText: "right recipient", isFromOperator: true, sentAt: 70 })
      .run();

    const ctx = buildDraftContext(db, "a1:t1m1");
    expect(ctx.sentToSender.map((m) => m.id)).toEqual(["a1:t1m3"]);
  });
});
