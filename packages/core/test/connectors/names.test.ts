import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../helpers/db";
import { accounts, messages, threads } from "../../src/db/schema";
import { chatNameFrom, contactNameFor, isNumberish, renameChatThreads } from "../../src/connectors/names";
import { searchMessages, indexMessageForSearch } from "../../src/chat/search";

describe("isNumberish", () => {
  it("reads a number however it is written, and never a name", () => {
    expect(isNumberish("+1 (415) 555\u20110133")).toBe(true);
    expect(isNumberish("\u202a+91 99999 00000\u202c")).toBe(true);
    expect(isNumberish("14155238886")).toBe(true);
    expect(isNumberish("60754")).toBe(true);
    expect(isNumberish("Grace")).toBe(false);
    expect(isNumberish("Agent 007")).toBe(false);
    expect(isNumberish("1234")).toBe(false);
  });
});

describe("chatNameFrom", () => {
  const contacts = new Map([["4155550133", "Priya Nair"], ["4155550100", "Sam Rivera"]]);
  it("keeps a name WhatsApp has, names a number from Contacts by phone or by the number itself, and leaves a stranger's number", () => {
    expect(chatNameFrom("Ada Lovelace", "14155550111", contacts)).toBe("Ada Lovelace");
    expect(chatNameFrom("\u202a+1 (415) 555\u20110133\u202c", "14155550133", contacts)).toBe("Priya Nair");
    expect(chatNameFrom("\u202a+1 (415) 555\u20110100\u202c", null, contacts)).toBe("Sam Rivera");
    expect(chatNameFrom("12345", "12345", contacts)).toBe("12345");
    expect(contactNameFor(contacts, null)).toBeNull();
  });
});

describe("renameChatThreads", () => {
  function seed(db: ReturnType<typeof testDb>) {
    db.insert(accounts).values({ id: "im", provider: "imessage", email: "messages:me", displayName: null, createdAt: 1 }).run();
    db.insert(threads).values([
      { id: "im:c1", accountId: "im", providerThreadId: "iMessage;-;+14155550100", subject: "+14155550100", lastMessageAt: 300, lastFromOperator: false },
      { id: "im:c2", accountId: "im", providerThreadId: "iMessage;-;+12025550123", subject: "+12025550123", lastMessageAt: 300, lastFromOperator: true },
    ]).run();
    const base = { accountId: "im", rfcMessageId: null, ccAddresses: [], snippet: null, attachmentNames: [], receivedAt: 1, bodyHtml: null, folder: "messages" as const };
    const rows = [
      { ...base, id: "im:t1", providerMessageId: "t1", threadId: "im:c1", fromAddress: "+14155550100", fromName: null, toAddresses: ["me"], subject: "+14155550100", bodyText: "hi there", isFromOperator: false, sentAt: 200 },
      { ...base, id: "im:t2", providerMessageId: "t2", threadId: "im:c1", fromAddress: "me", fromName: null, toAddresses: ["+14155550100"], subject: "+14155550100", bodyText: "hello", isFromOperator: true, sentAt: 300 },
      // Only ever written to: the handle is read off the to-address.
      { ...base, id: "im:t3", providerMessageId: "t3", threadId: "im:c2", fromAddress: "me", fromName: null, toAddresses: ["+12025550123"], subject: "+12025550123", bodyText: "you there?", isFromOperator: true, sentAt: 300 },
    ];
    db.insert(messages).values(rows).run();
    for (const r of rows) indexMessageForSearch(db, r);
  }

  it("renames the thread, every text, the sender of inbound texts, and the search index", () => {
    const db = testDb();
    seed(db);
    const names = new Map([["4155550100", "Sam Rivera"], ["2025550123", "Dana Cole"]]);
    const n = renameChatThreads(db, "im", (chat) => contactNameFor(names, chat.handle));
    expect(n).toBe(2);
    expect(db.select({ s: threads.subject }).from(threads).where(eq(threads.id, "im:c1")).get()?.s).toBe("Sam Rivera");
    expect(db.select().from(messages).where(eq(messages.threadId, "im:c1")).all().map((m) => [m.subject, m.fromName])).toEqual([["Sam Rivera", "Sam Rivera"], ["Sam Rivera", null]]);
    expect(db.select({ s: threads.subject }).from(threads).where(eq(threads.id, "im:c2")).get()?.s).toBe("Dana Cole");
    expect(searchMessages(db, "Rivera").map((h) => h.messageId).sort()).toEqual(["im:t1", "im:t2"]);
    // A second pass changes nothing.
    expect(renameChatThreads(db, "im", (chat) => contactNameFor(names, chat.handle))).toBe(0);
  });

  it("leaves a chat alone when nothing knows a name for it", () => {
    const db = testDb();
    seed(db);
    expect(renameChatThreads(db, "im", () => null)).toBe(0);
    expect(db.select({ s: threads.subject }).from(threads).where(eq(threads.id, "im:c1")).get()?.s).toBe("+14155550100");
  });
});
