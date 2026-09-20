import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../helpers/db";
import { accounts, messages, operatorAliases, sorts, threads } from "../../src/db/schema";
import { isOperatorMessage, listAliases, operatorAddresses, restampOperator, saveAliases } from "../../src/accounts/aliases";

type TestDb = ReturnType<typeof testDb>;

const base = { ccAddresses: [], snippet: null, attachmentNames: [], receivedAt: 1, bodyHtml: null, folder: "inbox" as const };

function seed(db: TestDb) {
  db.insert(accounts).values({ id: "a1", provider: "imap", email: "me@work.example.com", displayName: null, createdAt: 1 }).run();
  db.insert(threads)
    .values([
      { id: "a1:t1", accountId: "a1", providerThreadId: "t1", subject: "Pilot", lastMessageAt: 200, lastFromOperator: false },
      { id: "a1:t2", accountId: "a1", providerThreadId: "t2", subject: "Grant", lastMessageAt: 300, lastFromOperator: false },
    ])
    .run();
  db.insert(messages)
    .values([
      // Their own mail from another address of theirs, stored as inbound.
      { ...base, id: "a1:m1", accountId: "a1", providerMessageId: "1", threadId: "a1:t1", rfcMessageId: null, fromAddress: "me@school.example.com", fromName: "Robin Doe", toAddresses: ["bob@x.com"], subject: "Pilot", bodyText: "Sending this over.", isFromOperator: false, sentAt: 200 },
      // The same, arriving through a relay with the real address in the name.
      { ...base, id: "a1:m2", accountId: "a1", providerMessageId: "2", threadId: "a1:t2", rfcMessageId: null, fromAddress: "office365@messaging.microsoft.com", fromName: "me@other.example.com", toAddresses: ["grants@x.com"], subject: "Grant", bodyText: "Attached.", isFromOperator: false, sentAt: 300 },
      // Someone else, who must not move.
      { ...base, id: "a1:m3", accountId: "a1", providerMessageId: "3", threadId: "a1:t1", rfcMessageId: null, fromAddress: "bob@x.com", fromName: "Bob", toAddresses: ["me@work.example.com"], subject: "Pilot", bodyText: "Thanks.", isFromOperator: false, sentAt: 100 },
    ])
    .run();
  db.insert(sorts)
    .values([
      { messageId: "a1:m1", wants: "reply", scheduling: false, category: "Needs reply", finance: "none", reason: "x", model: "m", labeledAt: null, createdAt: 1 },
      { messageId: "a1:m3", wants: "reply", scheduling: false, category: "Needs reply", finance: "none", reason: "y", model: "m", labeledAt: null, createdAt: 1 },
    ])
    .run();
}

describe("saveAliases", () => {
  it("lowercases, trims, and keeps one of each", () => {
    const db = testDb();
    saveAliases(db, ["  Me@School.Example.com ", "me@school.example.com", "b@x.com"]);
    expect(listAliases(db).map((a) => a.address)).toEqual(["b@x.com", "me@school.example.com"]);
  });

  it("refuses something that is not an address, and writes nothing", () => {
    const db = testDb();
    saveAliases(db, ["a@x.com"]);
    expect(() => saveAliases(db, ["a@x.com", "not an email"])).toThrow(/not an email address/i);
    expect(listAliases(db).map((a) => a.address)).toEqual(["a@x.com"]);
  });

  it("replaces the list, and an address that stays keeps the day it was added", () => {
    const db = testDb();
    saveAliases(db, ["a@x.com"], () => 100);
    saveAliases(db, ["a@x.com", "b@x.com"], () => 200);
    expect(listAliases(db).map((a) => [a.address, a.createdAt])).toEqual([
      ["a@x.com", 100],
      ["b@x.com", 200],
    ]);
    saveAliases(db, []);
    expect(listAliases(db)).toEqual([]);
  });
});

describe("operatorAddresses", () => {
  it("is every inbox they read plus every alias they added", () => {
    const db = testDb();
    seed(db);
    saveAliases(db, ["Me@School.Example.com"]);
    expect([...operatorAddresses(db)].sort()).toEqual(["me@school.example.com", "me@work.example.com"]);
  });
});

describe("isOperatorMessage", () => {
  const operators = new Set(["me@work.example.com", "me@school.example.com", "me@other.example.com"]);

  it("knows them by any of their own addresses", () => {
    expect(isOperatorMessage({ fromAddress: "me@school.example.com", fromName: "Robin" }, operators)).toBe(true);
    expect(isOperatorMessage({ fromAddress: "  Me@School.Example.com ", fromName: null }, operators)).toBe(true);
    expect(isOperatorMessage({ fromAddress: "bob@x.com", fromName: "Bob" }, operators)).toBe(false);
  });

  it("reads through a relay, where the real address is the display name", () => {
    const relayed = { fromAddress: "office365@messaging.microsoft.com", fromName: "me@other.example.com" };
    expect(isOperatorMessage(relayed, operators)).toBe(true);
    // The same relay carrying somebody else is somebody else.
    expect(isOperatorMessage({ ...relayed, fromName: "someone@elsewhere.com" }, operators)).toBe(false);
    expect(isOperatorMessage({ ...relayed, fromName: null }, operators)).toBe(false);
  });

  it("does not read a display name from an ordinary sender", () => {
    // Anyone can put an address in their display name; only a relay is trusted.
    expect(isOperatorMessage({ fromAddress: "spoof@x.com", fromName: "me@school.example.com" }, operators)).toBe(false);
  });
});

describe("restampOperator", () => {
  it("moves their own mail to their side, thread and all, and drops its verdicts", () => {
    const db = testDb();
    seed(db);
    saveAliases(db, ["me@school.example.com", "me@other.example.com"]);

    expect(restampOperator(db)).toEqual({ messages: 2, threads: 2, sorts: 2 });

    const byId = Object.fromEntries(db.select().from(messages).all().map((m) => [m.id, m]));
    expect(byId["a1:m1"]!.isFromOperator).toBe(true);
    expect(byId["a1:m2"]!.isFromOperator).toBe(true);
    expect(byId["a1:m3"]!.isFromOperator).toBe(false);

    // Both threads now end with the operator, which is what "waiting" reads.
    expect(db.select().from(threads).all().every((t) => t.lastFromOperator)).toBe(true);
    // A verdict about their own mail is meaningless and would keep it in the counts.
    expect(db.select().from(sorts).all().map((s) => s.messageId)).toEqual(["a1:m3"]);
  });

  it("changes nothing when the set has not changed", () => {
    const db = testDb();
    seed(db);
    expect(restampOperator(db)).toEqual({ messages: 0, threads: 0, sorts: 0 });
    expect(db.select().from(sorts).all()).toHaveLength(2);
  });

  it("moves mail back when an alias is removed", () => {
    const db = testDb();
    seed(db);
    saveAliases(db, ["me@school.example.com"]);
    restampOperator(db);
    expect(db.select().from(messages).where(eq(messages.id, "a1:m1")).get()!.isFromOperator).toBe(true);

    saveAliases(db, []);
    expect(restampOperator(db).messages).toBe(1);
    expect(db.select().from(messages).where(eq(messages.id, "a1:m1")).get()!.isFromOperator).toBe(false);
    // The sort it lost does not come back; the next pass gives it a new one.
    expect(db.select().from(sorts).all().map((s) => s.messageId)).toEqual(["a1:m3"]);
  });

  it("leaves the alias table alone", () => {
    const db = testDb();
    seed(db);
    saveAliases(db, ["me@school.example.com"]);
    restampOperator(db);
    expect(db.select().from(operatorAliases).all()).toHaveLength(1);
  });
});
