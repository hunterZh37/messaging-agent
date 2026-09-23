import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../helpers/db";
import { accounts, drafts, messages } from "../../src/db/schema";
import { composeDraft, firstContact } from "../../src/queue/compose";

function seedAccounts(db: ReturnType<typeof testDb>) {
  db.insert(accounts).values([
    { id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: 1 },
    { id: "a2", provider: "outlook", email: "work@example.com", displayName: null, createdAt: 1 },
    { id: "im", provider: "imessage", email: "messages:me", displayName: null, createdAt: 1 },
    { id: "wa", provider: "whatsapp", email: "whatsapp:1", displayName: null, createdAt: 1 },
  ]).run();
}

describe("composeDraft", () => {
  it("writes a pending draft with mode new, no thread, no reply-to, its own account and subject", () => {
    const db = testDb();
    seedAccounts(db);

    const row = composeDraft(db, { accountId: "a1", to: ["bob@x.com"], subject: "Hello", text: "Hi Bob." }, () => 1000);

    expect(row).toMatchObject({
      threadId: null,
      replyToMessageId: null,
      accountId: "a1",
      subject: "Hello",
      originalText: "Hi Bob.",
      toAddresses: ["bob@x.com"],
      ccAddresses: [],
      status: "pending",
      mode: "new",
      model: "operator",
      createdAt: 1000,
      updatedAt: 1000,
    });
    const stored = db.select().from(drafts).where(eq(drafts.id, row.id)).get();
    expect(stored).toMatchObject({ accountId: "a1", subject: "Hello", mode: "new" });
  });

  it("carries the model name it was drafted by, when given one", () => {
    const db = testDb();
    seedAccounts(db);
    const row = composeDraft(db, { accountId: "a1", to: ["bob@x.com"], subject: "Hello", text: "Hi.", model: "gpt-5" });
    expect(row.model).toBe("gpt-5");
  });

  it("trims whitespace off To and Cc addresses and drops blanks", () => {
    const db = testDb();
    seedAccounts(db);
    const row = composeDraft(db, {
      accountId: "a1",
      to: [" bob@x.com ", "", "  "],
      cc: [" carol@x.com ", ""],
      subject: "  Hello  ",
      text: "Hi.",
    });
    expect(row.toAddresses).toEqual(["bob@x.com"]);
    expect(row.ccAddresses).toEqual(["carol@x.com"]);
    // The subject itself is trimmed too.
    expect(row.subject).toBe("Hello");
  });

  it("rejects an empty To", () => {
    const db = testDb();
    seedAccounts(db);
    expect(() => composeDraft(db, { accountId: "a1", to: [], subject: "Hello", text: "Hi." })).toThrow(/To recipient/);
    expect(() => composeDraft(db, { accountId: "a1", to: ["   "], subject: "Hello", text: "Hi." })).toThrow(/To recipient/);
  });

  it("rejects an empty subject", () => {
    const db = testDb();
    seedAccounts(db);
    expect(() => composeDraft(db, { accountId: "a1", to: ["bob@x.com"], subject: "", text: "Hi." })).toThrow(/subject/);
    expect(() => composeDraft(db, { accountId: "a1", to: ["bob@x.com"], subject: "   ", text: "Hi." })).toThrow(/subject/);
  });

  it("rejects an unknown account", () => {
    const db = testDb();
    seedAccounts(db);
    expect(() => composeDraft(db, { accountId: "gone", to: ["bob@x.com"], subject: "Hello", text: "Hi." })).toThrow(/account not found/);
  });

  it("rejects a bad address", () => {
    const db = testDb();
    seedAccounts(db);
    expect(() => composeDraft(db, { accountId: "a1", to: ["not an address"], subject: "Hello", text: "Hi." })).toThrow(/invalid recipient/);
    expect(() => composeDraft(db, { accountId: "a1", to: ["bob@x.com"], cc: ["also bad"], subject: "Hello", text: "Hi." })).toThrow(/invalid recipient/);
  });

  it("refuses an imessage account with a clear message", () => {
    const db = testDb();
    seedAccounts(db);
    expect(() => composeDraft(db, { accountId: "im", to: ["bob@x.com"], subject: "Hello", text: "Hi." })).toThrow(
      "compose is not supported for imessage yet",
    );
  });

  it("refuses a whatsapp account with a clear message", () => {
    const db = testDb();
    seedAccounts(db);
    expect(() => composeDraft(db, { accountId: "wa", to: ["bob@x.com"], subject: "Hello", text: "Hi." })).toThrow(
      "compose is not supported for whatsapp yet",
    );
  });

  it("works for an outlook account too, not only imap", () => {
    const db = testDb();
    seedAccounts(db);
    const row = composeDraft(db, { accountId: "a2", to: ["bob@x.com"], subject: "Hello", text: "Hi." });
    expect(row.accountId).toBe("a2");
  });
});

describe("firstContact", () => {
  function seedMessages(db: ReturnType<typeof testDb>) {
    seedAccounts(db);
    db.insert(messages).values([
      {
        id: "a1:m1", accountId: "a1", providerMessageId: "m1", threadId: "a1:t1", rfcMessageId: "<m1@x>",
        fromAddress: "bob@x.com", fromName: null, toAddresses: ["me@example.com"], ccAddresses: [],
        subject: "Hi", bodyText: "hello", snippet: null, attachmentNames: [], isFromOperator: false, sentAt: 100, receivedAt: 100,
      },
      {
        id: "a1:m2", accountId: "a1", providerMessageId: "m2", threadId: "a1:t2", rfcMessageId: "<m2@x>",
        fromAddress: "me@example.com", fromName: null, toAddresses: ["carol@x.com"], ccAddresses: ["dave@x.com"],
        subject: "Hi", bodyText: "hello", snippet: null, attachmentNames: [], isFromOperator: true, sentAt: 200, receivedAt: 200,
      },
      // Same address, but a different account: should not count for a1.
      {
        id: "a2:m1", accountId: "a2", providerMessageId: "m1", threadId: "a2:t1", rfcMessageId: "<a2m1@x>",
        fromAddress: "erin@x.com", fromName: null, toAddresses: ["work@example.com"], ccAddresses: [],
        subject: "Hi", bodyText: "hello", snippet: null, attachmentNames: [], isFromOperator: false, sentAt: 100, receivedAt: 100,
      },
    ]).run();
  }

  it("returns addresses never exchanged with, on this account", () => {
    const db = testDb();
    seedMessages(db);
    expect(firstContact(db, "a1", ["frank@x.com"])).toEqual(["frank@x.com"]);
  });

  it("finds an address that appears as a message's from address", () => {
    const db = testDb();
    seedMessages(db);
    expect(firstContact(db, "a1", ["bob@x.com"])).toEqual([]);
  });

  it("finds an address in the JSON toAddresses array", () => {
    const db = testDb();
    seedMessages(db);
    expect(firstContact(db, "a1", ["carol@x.com"])).toEqual([]);
  });

  it("finds an address in the JSON ccAddresses array", () => {
    const db = testDb();
    seedMessages(db);
    expect(firstContact(db, "a1", ["dave@x.com"])).toEqual([]);
  });

  it("is case-insensitive", () => {
    const db = testDb();
    seedMessages(db);
    expect(firstContact(db, "a1", ["BOB@X.COM"])).toEqual([]);
    expect(firstContact(db, "a1", ["Carol@X.Com"])).toEqual([]);
  });

  it("scopes by account: an address seen on another account is still first contact here", () => {
    const db = testDb();
    seedMessages(db);
    expect(firstContact(db, "a1", ["erin@x.com"])).toEqual(["erin@x.com"]);
    expect(firstContact(db, "a2", ["erin@x.com"])).toEqual([]);
  });

  it("dedupes the addresses it returns", () => {
    const db = testDb();
    seedMessages(db);
    expect(firstContact(db, "a1", ["frank@x.com", "Frank@X.Com", " frank@x.com "])).toEqual(["frank@x.com"]);
  });

  it("skips blank addresses", () => {
    const db = testDb();
    seedMessages(db);
    expect(firstContact(db, "a1", ["", "   "])).toEqual([]);
  });
});
