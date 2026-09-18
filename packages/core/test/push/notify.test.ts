import { describe, it, expect } from "vitest";
import { testDb } from "../helpers/db";
import { accounts, messages, sorts, threads } from "../../src/db/schema";
import { deleteSubscription, listSubscriptions, needsReplySince, noticeFor, noticesFor, saveSubscription } from "../../src/push/notify";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 14, 20, 0, 0);
const base = { ccAddresses: [], attachmentNames: [], bodyHtml: null, rfcMessageId: null };

function seed(db: ReturnType<typeof testDb>) {
  db.insert(accounts).values([
    { id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: NOW - DAY },
    { id: "im", provider: "imessage", email: "messages:me", displayName: null, createdAt: NOW - DAY },
  ]).run();
  db.insert(threads).values([
    { id: "a1:t1", accountId: "a1", providerThreadId: "t1", subject: "Contract", lastMessageAt: NOW - 1000, lastFromOperator: false },
    { id: "a1:t2", accountId: "a1", providerThreadId: "t2", subject: "Newsletter", lastMessageAt: NOW - 1000, lastFromOperator: false },
    { id: "im:c1", accountId: "im", providerThreadId: "c1", subject: "Grace", lastMessageAt: NOW - 500, lastFromOperator: false },
  ]).run();
  db.insert(messages).values([
    { ...base, id: "a1:m1", accountId: "a1", providerMessageId: "m1", threadId: "a1:t1", fromAddress: "keith@x.org", fromName: "Keith Calix", toAddresses: ["me@example.com"], subject: "Contract", bodyText: "Can you sign the updated contract by Friday?", snippet: "Can you sign the updated contract by Friday?", isFromOperator: false, folder: "inbox", sentAt: NOW - 1000, receivedAt: NOW - 900 },
    { ...base, id: "a1:m2", accountId: "a1", providerMessageId: "m2", threadId: "a1:t2", fromAddress: "news@x.com", fromName: "News", toAddresses: ["me@example.com"], subject: "Newsletter", bodyText: "This week", snippet: "This week", isFromOperator: false, folder: "inbox", sentAt: NOW - 1000, receivedAt: NOW - 900 },
    { ...base, id: "im:t1", accountId: "im", providerMessageId: "t1", threadId: "im:c1", fromAddress: "grace@icloud.com", fromName: "Grace", toAddresses: ["me"], subject: "Grace", bodyText: "dinner tonight?", snippet: "dinner tonight?", isFromOperator: false, folder: "messages", sentAt: NOW - 500, receivedAt: NOW - 400 },
  ]).run();
  const s = { scheduling: false, reason: "", model: "x", labeledAt: null, createdAt: 1 };
  db.insert(sorts).values([
    { ...s, messageId: "a1:m1", important: true, needsReply: true },
    { ...s, messageId: "a1:m2", important: false, needsReply: false },
  ]).run();
}

/** What the phone is told about (2026-09-14). */
describe("needsReplySince", () => {
  it("is what landed in Need to reply since the last notice, mail and chats, newest first", () => {
    const db = testDb();
    seed(db);
    expect(needsReplySince(db, NOW - 10_000, { now: NOW }).map((r) => r.message.id)).toEqual(["im:t1", "a1:m1"]);
    // Nothing is said twice.
    expect(needsReplySince(db, NOW - 400, { now: NOW })).toEqual([]);
  });
});

describe("noticeFor / noticesFor", () => {
  it("names who wrote, the subject for mail, and links to the thread", () => {
    const db = testDb();
    seed(db);
    const [chat, mail] = needsReplySince(db, 0, { now: NOW });
    expect(noticeFor(chat!)).toEqual({ title: "Grace", body: "dinner tonight?", url: "/inbox/im%3Ac1?folder=messages&status=needs_reply", tag: "im:c1" });
    expect(noticeFor(mail!)).toMatchObject({ title: "Keith Calix", body: "Contract: Can you sign the updated contract by Friday?", tag: "a1:t1" });
  });

  it("keeps the lock screen short, and turns a flood into one notice", () => {
    const db = testDb();
    seed(db);
    const [row] = needsReplySince(db, 0, { now: NOW });
    const long = { ...row!, message: { ...row!.message, snippet: "x".repeat(300) } };
    expect(noticeFor(long).body.length).toBeLessThanOrEqual(90);
    const many = [1, 2, 3, 4].map((i) => ({ ...row!, thread: { ...row!.thread, id: `t${i}` } }));
    expect(noticesFor(many)).toEqual([{ title: "Celeste", body: "4 new messages need a reply", url: "/inbox?status=needs_reply", tag: "celeste-batch" }]);
    expect(noticesFor(many.slice(0, 2))).toHaveLength(2);
  });
});

describe("push subscriptions", () => {
  it("saves one per endpoint, updates its keys, and forgets it", () => {
    const db = testDb();
    saveSubscription(db, { endpoint: "https://push.example/1", keys: { p256dh: "a", auth: "b" } }, "iPhone", () => 1);
    saveSubscription(db, { endpoint: "https://push.example/1", keys: { p256dh: "c", auth: "d" } }, "iPhone", () => 2);
    expect(listSubscriptions(db)).toEqual([{ endpoint: "https://push.example/1", keys: { p256dh: "c", auth: "d" } }]);
    deleteSubscription(db, "https://push.example/1");
    expect(listSubscriptions(db)).toEqual([]);
  });
});
