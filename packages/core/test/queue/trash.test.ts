import { describe, it, expect } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { testConfig, testDb } from "../helpers/db";
import { storeNormalizedMessage } from "../../src/connectors/store";
import { FakeImapClient, fakeMessage } from "../helpers/fakeImap";
import { FakeOutlookClient, fakeGraphMessage } from "../helpers/fakeOutlook";
import { accounts, actions, messages, threads } from "../../src/db/schema";
import type { MailConnector } from "../../src/connectors/types";
import { restoreImapMessages, trashImapMessages } from "../../src/imap/trash";
import { restoreOutlookMessages, trashOutlookMessages } from "../../src/outlook/trash";
import {
  absorbCopy,
  convertLegacyHides,
  hiddenFrom,
  hideThreads,
  unhideThreads,
  inboxMessagesForThreads,
  markHidden,
  markRestored,
  markTrashed,
  restoreHidden,
  restoreThreads,
  trashMessagesForThreads,
  trashThreads,
} from "../../src/queue/trash";
import { listInboxMessages } from "../../src/queue/inbox";

const base = { fromName: null, ccAddresses: [], snippet: null, attachmentNames: [], receivedAt: 1, bodyHtml: null };

/**
 * Two inboxes: a Gmail one holding a marketing thread the operator answered
 * once, and an Outlook one holding a promotion.
 */
function seed(db: ReturnType<typeof testDb>) {
  db.insert(accounts)
    .values([
      { id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: 1 },
      { id: "a2", provider: "outlook", email: "work@example.com", displayName: null, createdAt: 1 },
    ])
    .run();
  db.insert(threads)
    .values([
      { id: "a1:t1", accountId: "a1", providerThreadId: "t1", subject: "Sale", lastMessageAt: 300, lastFromOperator: true },
      { id: "a1:t2", accountId: "a1", providerThreadId: "t2", subject: "Contract", lastMessageAt: 400, lastFromOperator: false },
      { id: "a2:t3", accountId: "a2", providerThreadId: "t3", subject: "Promo", lastMessageAt: 500, lastFromOperator: false },
    ])
    .run();
  db.insert(messages)
    .values([
      { ...base, id: "a1:m1", accountId: "a1", providerMessageId: "INBOX:1", threadId: "a1:t1", rfcMessageId: null, fromAddress: "sale@shop.com", toAddresses: ["me@example.com"], subject: "Sale", bodyText: "50% off.", isFromOperator: false, folder: "inbox", sentAt: 100 },
      { ...base, id: "a1:m2", accountId: "a1", providerMessageId: "INBOX:2", threadId: "a1:t1", rfcMessageId: null, fromAddress: "sale@shop.com", toAddresses: ["me@example.com"], subject: "Sale", bodyText: "Last chance.", isFromOperator: false, folder: "inbox", sentAt: 200 },
      // The operator's own word in the same thread: it stays where it is.
      { ...base, id: "a1:s1", accountId: "a1", providerMessageId: "[Gmail]/Sent Mail:1", threadId: "a1:t1", rfcMessageId: null, fromAddress: "me@example.com", toAddresses: ["sale@shop.com"], subject: "Sale", bodyText: "Unsubscribe me.", isFromOperator: true, folder: "sent", sentAt: 300 },
      { ...base, id: "a1:m3", accountId: "a1", providerMessageId: "INBOX:3", threadId: "a1:t2", rfcMessageId: null, fromAddress: "legal@firm.com", toAddresses: ["me@example.com"], subject: "Contract", bodyText: "Signed.", isFromOperator: false, folder: "inbox", sentAt: 400 },
      { ...base, id: "a2:m4", accountId: "a2", providerMessageId: "graph-4", threadId: "a2:t3", rfcMessageId: null, fromAddress: "promo@shop.com", toAddresses: ["work@example.com"], subject: "Promo", bodyText: "Deal.", isFromOperator: false, folder: "inbox", sentAt: 500 },
    ])
    .run();
}

const folderOf = (db: ReturnType<typeof testDb>, id: string) =>
  db.select({ folder: messages.folder }).from(messages).where(eq(messages.id, id)).get()?.folder;

describe("markTrashed", () => {
  it("files the rows under Trash and records one action each", () => {
    const db = testDb();
    seed(db);
    markTrashed(db, ["a1:m1", "a1:m2"], () => 999);

    expect(folderOf(db, "a1:m1")).toBe("trash");
    expect(folderOf(db, "a1:m2")).toBe("trash");
    const rows = db.select().from(actions).where(eq(actions.kind, "trash")).all();
    expect(rows.map((r) => r.messageId).sort()).toEqual(["a1:m1", "a1:m2"]);
    expect(rows.every((r) => r.createdAt === 999)).toBe(true);
  });

  it("does nothing at all for an empty set", () => {
    const db = testDb();
    seed(db);
    markTrashed(db, []);
    expect(db.select().from(actions).all()).toEqual([]);
    expect(folderOf(db, "a1:m1")).toBe("inbox");
  });
});

describe("markRestored", () => {
  it("files the rows under Inbox and records one restore action each", () => {
    const db = testDb();
    seed(db);
    markTrashed(db, ["a1:m1", "a1:m2"]);
    markRestored(db, ["a1:m1", "a1:m2"], () => 999);

    expect(folderOf(db, "a1:m1")).toBe("inbox");
    expect(folderOf(db, "a1:m2")).toBe("inbox");
    const rows = db.select().from(actions).where(eq(actions.kind, "restore")).all();
    expect(rows.map((r) => r.messageId).sort()).toEqual(["a1:m1", "a1:m2"]);
    expect(rows.every((r) => r.createdAt === 999)).toBe(true);
  });

  it("does nothing at all for an empty set", () => {
    const db = testDb();
    seed(db);
    markTrashed(db, ["a1:m1"]);
    markRestored(db, []);
    expect(db.select().from(actions).where(eq(actions.kind, "restore")).all()).toEqual([]);
    expect(folderOf(db, "a1:m1")).toBe("trash");
  });
});

describe("trashMessagesForThreads", () => {
  it("takes every inbound message of a thread that is sitting in Trash", () => {
    const db = testDb();
    seed(db);
    markTrashed(db, ["a1:m1", "a1:m2"]);
    const byAccount = trashMessagesForThreads(db, ["a1:t1"]);
    expect([...byAccount.keys()]).toEqual(["a1"]);
    expect(byAccount.get("a1")!.sort()).toEqual(["a1:m1", "a1:m2"]);
  });

  it("leaves out mail that is still in the inbox and the operator's own", () => {
    const db = testDb();
    seed(db);
    // a1:t1 holds a1:m1 (inbox), a1:m2 (inbox) and a1:s1 (sent, the operator's own): none of it is in Trash yet.
    const byAccount = trashMessagesForThreads(db, ["a1:t1"]);
    expect(byAccount.size).toBe(0);
  });
});

describe("inboxMessagesForThreads", () => {
  it("takes every inbound message of a thread and leaves the operator's own alone", () => {
    const db = testDb();
    seed(db);
    const byAccount = inboxMessagesForThreads(db, ["a1:t1"]);
    expect([...byAccount.keys()]).toEqual(["a1"]);
    expect(byAccount.get("a1")!.sort()).toEqual(["a1:m1", "a1:m2"]);
  });

  it("groups by inbox, so each provider is called once", () => {
    const db = testDb();
    seed(db);
    const byAccount = inboxMessagesForThreads(db, ["a1:t1", "a1:t2", "a2:t3", "a1:t1"]);
    expect(byAccount.get("a1")!.sort()).toEqual(["a1:m1", "a1:m2", "a1:m3"]);
    expect(byAccount.get("a2")).toEqual(["a2:m4"]);
  });
});

describe("trashImapMessages", () => {
  function withMail(): FakeImapClient {
    const imap = new FakeImapClient();
    imap.add("INBOX", fakeMessage({ uid: 1, from: "sale@shop.com" }), fakeMessage({ uid: 2, from: "sale@shop.com" }));
    return imap;
  }

  it("moves the uids to the server's Trash folder and files the rows there", async () => {
    const db = testDb();
    seed(db);
    const imap = withMail();

    expect(await trashImapMessages(db, imap, ["a1:m1", "a1:m2"])).toEqual({ moved: 2, failed: 0 });
    expect(imap.moveCalls).toEqual([{ folder: "INBOX", uids: [1, 2], destination: "[Gmail]/Trash" }]);
    expect(imap.folderState.get("INBOX")!.messages).toEqual([]);
    expect(imap.folderState.get("[Gmail]/Trash")!.messages).toHaveLength(2);
    expect(folderOf(db, "a1:m1")).toBe("trash");
    // The uid the message moved into is recorded, not the old one, so a
    // restore later knows where to look (spec 10a, 2026-09-11).
    expect(
      db
        .select({ id: messages.id, providerMessageId: messages.providerMessageId })
        .from(messages)
        .where(inArray(messages.id, ["a1:m1", "a1:m2"]))
        .all()
        .sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual([
      { id: "a1:m1", providerMessageId: "[Gmail]/Trash:1" },
      { id: "a1:m2", providerMessageId: "[Gmail]/Trash:2" },
    ]);
    // One connection, opened and closed, as every other IMAP operation does.
    expect({ connects: imap.connects, closes: imap.closes }).toEqual({ connects: 1, closes: 1 });
  });

  it("leaves the id alone when the server gives no uid map back", async () => {
    const db = testDb();
    seed(db);
    const imap = withMail();
    imap.moveReturnsUidMap = false;

    expect(await trashImapMessages(db, imap, ["a1:m1"])).toEqual({ moved: 1, failed: 0 });
    expect(folderOf(db, "a1:m1")).toBe("trash");
    expect(db.select({ providerMessageId: messages.providerMessageId }).from(messages).where(eq(messages.id, "a1:m1")).get()?.providerMessageId).toBe(
      "INBOX:1",
    );
  });

  it("leaves a message where it is when the server refuses the move", async () => {
    const db = testDb();
    seed(db);
    const imap = withMail();
    imap.moveErrors.set("INBOX", new Error("OVERQUOTA"));

    expect(await trashImapMessages(db, imap, ["a1:m1", "a1:m2"])).toEqual({ moved: 0, failed: 2 });
    // Nothing moved, so nothing says it did: the list must not show a delete
    // that never happened.
    expect(folderOf(db, "a1:m1")).toBe("inbox");
    expect(db.select().from(actions).all()).toEqual([]);
    expect(imap.closes).toBe(1);
  });

  it("refuses a mailbox with no Trash folder rather than deleting anything", async () => {
    const db = testDb();
    seed(db);
    const imap = withMail();
    imap.trashPath = null;

    await expect(trashImapMessages(db, imap, ["a1:m1"])).rejects.toThrow(/no Trash folder/);
    expect(folderOf(db, "a1:m1")).toBe("inbox");
    expect(imap.closes).toBe(1);
  });

  it("counts a message it cannot address, and says nothing happened for an empty set", async () => {
    const db = testDb();
    seed(db);
    const imap = withMail();
    expect(await trashImapMessages(db, imap, ["a1:m1", "gone"])).toEqual({ moved: 1, failed: 1 });
    expect(await trashImapMessages(db, imap, [])).toEqual({ moved: 0, failed: 0 });
  });
});

describe("restoreImapMessages", () => {
  it("moves a message from Trash back to INBOX and records the new uid", async () => {
    const db = testDb();
    seed(db);
    const imap = new FakeImapClient();
    const trashed = fakeMessage({ uid: 5, from: "sale@shop.com" });
    imap.add("[Gmail]/Trash", trashed);
    db.update(messages).set({ providerMessageId: "[Gmail]/Trash:5", folder: "trash", rfcMessageId: trashed.rfcMessageId! }).where(eq(messages.id, "a1:m1")).run();

    expect(await restoreImapMessages(db, imap, ["a1:m1"])).toEqual({ moved: 1, failed: 0 });
    expect(imap.moveCalls).toEqual([{ folder: "[Gmail]/Trash", uids: [5], destination: "INBOX" }]);
    const row = db.select().from(messages).where(eq(messages.id, "a1:m1")).get()!;
    expect(row.folder).toBe("inbox");
    expect(row.providerMessageId).toBe("INBOX:1");
    expect(db.select().from(actions).where(eq(actions.kind, "restore")).all().map((r) => r.messageId)).toEqual(["a1:m1"]);
  });

  it("falls back to a Message-ID search when the stored id does not sit in Trash", async () => {
    const db = testDb();
    seed(db);
    const imap = new FakeImapClient();
    // The stored id is stale, still the pre-delete inbox uid: the trash move
    // that put it here gave back no uid map (spec 10a, 2026-09-11). Only the
    // Message-ID says where it actually landed.
    const trashed = fakeMessage({ uid: 9, from: "sale@shop.com", messageId: "<stale@example.com>" });
    imap.add("[Gmail]/Trash", trashed);
    db.update(messages).set({ providerMessageId: "INBOX:1", folder: "trash", rfcMessageId: "<stale@example.com>" }).where(eq(messages.id, "a1:m1")).run();

    expect(await restoreImapMessages(db, imap, ["a1:m1"])).toEqual({ moved: 1, failed: 0 });
    expect(imap.findByMessageIdCalls).toEqual([{ folder: "[Gmail]/Trash", rfcMessageId: "<stale@example.com>" }]);
    expect(imap.moveCalls).toEqual([{ folder: "[Gmail]/Trash", uids: [9], destination: "INBOX" }]);
    expect(folderOf(db, "a1:m1")).toBe("inbox");
  });

  it("counts a message with no Message-ID to fall back on", async () => {
    const db = testDb();
    seed(db);
    const imap = new FakeImapClient();
    db.update(messages).set({ providerMessageId: "INBOX:1", folder: "trash", rfcMessageId: null }).where(eq(messages.id, "a1:m1")).run();

    expect(await restoreImapMessages(db, imap, ["a1:m1"])).toEqual({ moved: 0, failed: 1 });
    expect(folderOf(db, "a1:m1")).toBe("trash");
  });

  it("goes through trash then restore end to end when the server has no UIDPLUS", async () => {
    const db = testDb();
    seed(db);
    const imap = new FakeImapClient();
    imap.add("INBOX", fakeMessage({ uid: 1, from: "sale@shop.com", messageId: "<roundtrip@example.com>" }));
    imap.moveReturnsUidMap = false;
    db.update(messages).set({ rfcMessageId: "<roundtrip@example.com>" }).where(eq(messages.id, "a1:m1")).run();

    expect(await trashImapMessages(db, imap, ["a1:m1"])).toEqual({ moved: 1, failed: 0 });
    expect(folderOf(db, "a1:m1")).toBe("trash");
    // The stored id never advanced, but the message really is in Trash now.
    expect(db.select({ providerMessageId: messages.providerMessageId }).from(messages).where(eq(messages.id, "a1:m1")).get()?.providerMessageId).toBe(
      "INBOX:1",
    );

    expect(await restoreImapMessages(db, imap, ["a1:m1"])).toEqual({ moved: 1, failed: 0 });
    expect(folderOf(db, "a1:m1")).toBe("inbox");
  });
});

describe("trashOutlookMessages", () => {
  function withMail(): FakeOutlookClient {
    const client = new FakeOutlookClient();
    client.addMessage("inbox", fakeGraphMessage({ id: "graph-4", from: "promo@shop.com" }));
    return client;
  }

  it("moves the message to Deleted Items and files the row under Trash", async () => {
    const db = testDb();
    seed(db);
    const client = withMail();

    expect(await trashOutlookMessages(db, client, ["a2:m4"])).toEqual({ moved: 1, failed: 0 });
    expect(client.moveCalls).toEqual([{ messageId: "graph-4", destination: "trash" }]);
    expect(client.stored.inbox).toEqual([]);
    expect(client.stored.trash).toHaveLength(1);
    expect(folderOf(db, "a2:m4")).toBe("trash");
    // Graph's new id for the moved message is recorded, not the old one, so
    // a restore later knows where to look (spec 10a, 2026-09-11).
    expect(db.select({ providerMessageId: messages.providerMessageId }).from(messages).where(eq(messages.id, "a2:m4")).get()?.providerMessageId).toBe(
      "graph-4@trash",
    );
  });

  it("counts a message Graph refuses without losing the rest of the batch", async () => {
    const db = testDb();
    seed(db);
    const client = withMail();
    client.addMessage("inbox", fakeGraphMessage({ id: "INBOX:1", from: "sale@shop.com" }));
    client.moveFailures.add("graph-4");

    expect(await trashOutlookMessages(db, client, ["a2:m4", "a1:m1"])).toEqual({ moved: 1, failed: 1 });
    expect(folderOf(db, "a2:m4")).toBe("inbox");
    expect(folderOf(db, "a1:m1")).toBe("trash");
  });
});

/**
 * An id Graph no longer knows, because the message moved in Outlook itself
 * after it was stored (2026-09-14: five deletes "kept by the provider" were
 * mail already in Deleted Items).
 */
describe("trashOutlookMessages: a message moved in Outlook since it was stored", () => {
  function stale(db: ReturnType<typeof testDb>) {
    seed(db);
    db.update(messages).set({ providerMessageId: "graph-4-old", rfcMessageId: "<promo@shop.com>" }).where(eq(messages.id, "a2:m4")).run();
  }

  it("counts one already in Deleted Items as deleted, under its current id", async () => {
    const db = testDb();
    stale(db);
    const client = new FakeOutlookClient();
    client.addMessage("trash", fakeGraphMessage({ id: "graph-4-now", from: "promo@shop.com", internetMessageId: "<promo@shop.com>" }));
    expect(await trashOutlookMessages(db, client, ["a2:m4"])).toEqual({ moved: 1, failed: 0 });
    expect(db.select().from(messages).where(eq(messages.id, "a2:m4")).get()).toMatchObject({ folder: "trash", providerMessageId: "graph-4-now" });
  });

  it("moves one now in another folder by its current id", async () => {
    const db = testDb();
    stale(db);
    const client = new FakeOutlookClient();
    client.addMessage("junk", fakeGraphMessage({ id: "graph-4-junk", from: "promo@shop.com", internetMessageId: "<promo@shop.com>" }));
    expect(await trashOutlookMessages(db, client, ["a2:m4"])).toEqual({ moved: 1, failed: 0 });
    expect(client.moveCalls.at(-1)).toEqual({ messageId: "graph-4-junk", destination: "trash" });
    expect(folderOf(db, "a2:m4")).toBe("trash");
  });

  it("counts one the mailbox no longer has as deleted", async () => {
    const db = testDb();
    stale(db);
    expect(await trashOutlookMessages(db, new FakeOutlookClient(), ["a2:m4"])).toEqual({ moved: 1, failed: 0 });
    expect(folderOf(db, "a2:m4")).toBe("trash");
  });

  it("still fails an id Graph refuses for another reason", async () => {
    const db = testDb();
    stale(db);
    const client = new FakeOutlookClient();
    client.moveFailures.add("graph-4-old");
    expect(await trashOutlookMessages(db, client, ["a2:m4"])).toEqual({ moved: 0, failed: 1 });
    expect(folderOf(db, "a2:m4")).toBe("inbox");
  });
});

describe("absorbCopy", () => {
  it("folds a second stored copy into the first: provider id and folder over, the copy gone", () => {
    const db = testDb();
    seed(db);
    db.insert(messages)
      .values({ ...base, id: "a2:copy", accountId: "a2", providerMessageId: "graph-4@trash", threadId: "a2:t3", rfcMessageId: null, fromAddress: "promo@shop.com", toAddresses: ["work@example.com"], subject: "Promo", bodyText: "Deal.", isFromOperator: false, folder: "trash", sentAt: 500 })
      .run();
    markHidden(db, ["a2:copy"]);
    absorbCopy(db, "a2:m4", "a2:copy");
    expect(db.select().from(messages).where(eq(messages.id, "a2:copy")).get()).toBeUndefined();
    expect(db.select().from(messages).where(eq(messages.id, "a2:m4")).get()).toMatchObject({ providerMessageId: "graph-4@trash", folder: "trash" });
    expect(db.select().from(actions).where(eq(actions.messageId, "a2:m4")).all().map((a) => a.kind)).toEqual(["hide"]);
  });
});

describe("restoreOutlookMessages", () => {
  function trashedMail(): FakeOutlookClient {
    const client = new FakeOutlookClient();
    client.addMessage("trash", fakeGraphMessage({ id: "graph-4-trashed", from: "promo@shop.com" }));
    return client;
  }

  it("moves the message back to Inbox, records the newer id and a restore action", async () => {
    const db = testDb();
    seed(db);
    db.update(messages).set({ providerMessageId: "graph-4-trashed", folder: "trash" }).where(eq(messages.id, "a2:m4")).run();
    const client = trashedMail();

    expect(await restoreOutlookMessages(db, client, ["a2:m4"])).toEqual({ moved: 1, failed: 0 });
    expect(client.moveCalls).toEqual([{ messageId: "graph-4-trashed", destination: "inbox" }]);
    const row = db.select().from(messages).where(eq(messages.id, "a2:m4")).get()!;
    expect(row.folder).toBe("inbox");
    expect(row.providerMessageId).toBe("graph-4-trashed@inbox");
    expect(db.select().from(actions).where(eq(actions.kind, "restore")).all().map((r) => r.messageId)).toEqual(["a2:m4"]);
  });

  it("counts a message Graph refuses and leaves it in Trash", async () => {
    const db = testDb();
    seed(db);
    db.update(messages).set({ providerMessageId: "graph-4-trashed", folder: "trash" }).where(eq(messages.id, "a2:m4")).run();
    const client = trashedMail();
    client.moveFailures.add("graph-4-trashed");

    expect(await restoreOutlookMessages(db, client, ["a2:m4"])).toEqual({ moved: 0, failed: 1 });
    expect(folderOf(db, "a2:m4")).toBe("trash");
    expect(db.select().from(actions).where(eq(actions.kind, "restore")).all()).toEqual([]);
  });
});

describe("trashThreads", () => {
  /** A connector that only knows how to trash, which is all this asks of it. */
  function connector(trash: MailConnector["trash"]): MailConnector {
    const no = () => {
      throw new Error("not part of a delete");
    };
    return { sync: no, backfill: no, applyLabels: no, fetchAttachment: no, trash, restore: no, sender: { sendReply: no } };
  }

  it("calls each inbox once, with its own messages", async () => {
    const db = testDb();
    seed(db);
    const seen: { email: string; messageIds: string[] }[] = [];
    const r = await trashThreads(
      db,
      (account) =>
        connector(async (trashDb, trashAccount, messageIds) => {
          seen.push({ email: trashAccount.email, messageIds: [...messageIds].sort() });
          markTrashed(trashDb, messageIds);
          return { moved: messageIds.length, failed: 0 };
        }),
      ["a1:t1", "a2:t3"],
    );

    expect(r).toEqual({ moved: 3, failed: 0 });
    expect(seen.map((s) => s.email).sort()).toEqual(["me@example.com", "work@example.com"]);
    expect(seen.find((s) => s.email === "me@example.com")!.messageIds).toEqual(["a1:m1", "a1:m2"]);
    // Both threads leave the inbox; the contract thread and the operator's
    // own reply stay exactly where they were.
    expect(listInboxMessages(db, {}).map((row) => row.message.id)).toEqual(["a1:m3"]);
    expect(folderOf(db, "a1:s1")).toBe("sent");
  });

  it("keeps the inboxes that worked when one provider throws", async () => {
    const db = testDb();
    seed(db);
    const r = await trashThreads(
      db,
      (account) =>
        connector(async (trashDb, _a, messageIds) => {
          if (account.id === "a2") throw new Error("Graph is down");
          markTrashed(trashDb, messageIds);
          return { moved: messageIds.length, failed: 0 };
        }),
      ["a1:t1", "a2:t3"],
    );

    // The reason comes back with the count (operator, 2026-09-19): a mailbox
    // that could not be written to is the operator's to fix, and a number
    // alone cannot tell them which one or why.
    expect(r).toEqual({ moved: 2, failed: 1, reasons: [{ email: "work@example.com", message: "Graph is down" }] });
    expect(folderOf(db, "a1:m1")).toBe("trash");
    expect(folderOf(db, "a2:m4")).toBe("inbox");
  });

  it("says nothing happened for threads that hold no inbound mail", async () => {
    const db = testDb();
    seed(db);
    const r = await trashThreads(db, () => connector(async () => ({ moved: 9, failed: 9 })), ["nope"]);
    expect(r).toEqual({ moved: 0, failed: 0 });
  });

  it("goes through the real IMAP path end to end", async () => {
    const db = testDb();
    seed(db);
    const imap = new FakeImapClient();
    imap.add("INBOX", fakeMessage({ uid: 1, from: "sale@shop.com" }), fakeMessage({ uid: 2, from: "sale@shop.com" }));

    const r = await trashThreads(db, () => connector((trashDb, _a, ids) => trashImapMessages(trashDb, imap, ids)), ["a1:t1"]);

    expect(r).toEqual({ moved: 2, failed: 0 });
    expect(imap.folderState.get("[Gmail]/Trash")!.messages).toHaveLength(2);
    expect(db.select().from(actions).where(eq(actions.kind, "trash")).all()).toHaveLength(2);
  });
});

describe("restoreThreads", () => {
  /** A connector that only knows how to restore, which is all this asks of it. */
  function connector(restore: MailConnector["restore"]): MailConnector {
    const no = () => {
      throw new Error("not part of an undo");
    };
    return { sync: no, backfill: no, applyLabels: no, fetchAttachment: no, trash: no, restore, sender: { sendReply: no } };
  }

  /** The seeded mailboxes with only their inbound mail already sitting in Trash. */
  function trashSeed(db: ReturnType<typeof testDb>) {
    seed(db);
    markTrashed(db, ["a1:m1", "a1:m2", "a2:m4"]);
  }

  it("calls each inbox once, with only its trashed inbound messages", async () => {
    const db = testDb();
    trashSeed(db);
    const seen: { email: string; messageIds: string[] }[] = [];
    const r = await restoreThreads(
      db,
      (account) =>
        connector(async (restoreDb, restoreAccount, messageIds) => {
          seen.push({ email: restoreAccount.email, messageIds: [...messageIds].sort() });
          markRestored(restoreDb, messageIds);
          return { moved: messageIds.length, failed: 0 };
        }),
      ["a1:t1", "a2:t3"],
    );

    expect(r).toEqual({ moved: 3, failed: 0 });
    expect(seen.map((s) => s.email).sort()).toEqual(["me@example.com", "work@example.com"]);
    expect(seen.find((s) => s.email === "me@example.com")!.messageIds).toEqual(["a1:m1", "a1:m2"]);
    expect(folderOf(db, "a1:m1")).toBe("inbox");
    expect(folderOf(db, "a2:m4")).toBe("inbox");
    // The operator's own reply was never trashed, so an undo never touches it.
    expect(folderOf(db, "a1:s1")).toBe("sent");
  });

  it("keeps the inboxes that worked when one provider throws", async () => {
    const db = testDb();
    trashSeed(db);
    const r = await restoreThreads(
      db,
      (account) =>
        connector(async (restoreDb, _a, messageIds) => {
          if (account.id === "a2") throw new Error("Graph is down");
          markRestored(restoreDb, messageIds);
          return { moved: messageIds.length, failed: 0 };
        }),
      ["a1:t1", "a2:t3"],
    );

    expect(r).toEqual({ moved: 2, failed: 1 });
    expect(folderOf(db, "a1:m1")).toBe("inbox");
    expect(folderOf(db, "a2:m4")).toBe("trash");
  });

  it("says nothing happened for threads that hold no trashed mail", async () => {
    const db = testDb();
    seed(db);
    const r = await restoreThreads(db, () => connector(async () => ({ moved: 9, failed: 9 })), ["a1:t1"]);
    expect(r).toEqual({ moved: 0, failed: 0 });
  });
});

describe("hideThreads", () => {
  it("takes the thread out of the mailbox and into Hidden; undo unhides it without the provider (2026-09-16)", async () => {
    const db = testDb();
    seed(db);
    expect(hideThreads(db, ["a1:t1"], () => 50)).toEqual({ moved: 1, failed: 0 });
    expect(folderOf(db, "a1:m1")).toBe("inbox");
    expect(folderOf(db, "a1:s1")).toBe("sent");
    expect(db.select({ h: threads.hiddenAt }).from(threads).where(eq(threads.id, "a1:t1")).get()?.h).toBe(50);
    // Out of the Inbox itself now, not only the sorting lists: it had stayed
    // there wearing a Hidden badge, which read as the hide not working
    // (operator, 2026-09-16).
    expect(listInboxMessages(db, { accountId: "a1" }).map((r) => r.message.id)).not.toContain("a1:m2");
    // Out of every sorting list.
    for (const status of ["needs_reply", "unopened", "no_reply", "disposable"] as const) {
      expect(listInboxMessages(db, { accountId: "a1", status }).map((r) => r.thread.id)).not.toContain("a1:t1");
    }
    // And findable in Hidden, once, however many messages it holds.
    const hiddenRows = listInboxMessages(db, { accountId: "a1", status: "hidden" });
    expect(hiddenRows.map((r) => r.thread.id)).toEqual(["a1:t1"]);

    // Undo asks no provider for anything.
    const asked: string[] = [];
    const connectorFor = (): MailConnector =>
      ({
        restore: async (_db: unknown, _account: unknown, ids: string[]) => (asked.push(...ids), { moved: ids.length, failed: 0 }),
      }) as unknown as MailConnector;
    expect(await restoreThreads(db, connectorFor, ["a1:t1"])).toEqual({ moved: 1, failed: 0 });
    expect(asked).toEqual([]);
    expect(db.select({ h: threads.hiddenAt }).from(threads).where(eq(threads.id, "a1:t1")).get()?.h).toBeNull();
    expect(unhideThreads(db, ["a1:t1"])).toBe(0);
  });

  it("converts a thread hidden the old way, in Deleted items, back to its folder and hidden; an app-made hide stays deleted", () => {
    const db = testDb();
    seed(db);
    markHidden(db, ["a1:m1", "a1:m2"], () => 40);
    markHidden(db, ["a1:m3"], () => 41, { auto: true });
    expect(convertLegacyHides(db, () => 60)).toBe(2);
    expect(folderOf(db, "a1:m1")).toBe("inbox");
    expect(folderOf(db, "a1:m3")).toBe("trash");
    expect(db.select({ h: threads.hiddenAt }).from(threads).where(eq(threads.id, "a1:t1")).get()?.h).toBe(40);
    expect(convertLegacyHides(db, () => 70)).toBe(0);
  });

  it("restores a hidden chat to the Messages folder", () => {
    const db = testDb();
    seed(db);
    db.update(messages).set({ folder: "messages" }).where(eq(messages.id, "a1:m3")).run();
    markHidden(db, ["a1:m3"]);
    expect(folderOf(db, "a1:m3")).toBe("trash");
    restoreHidden(db, hiddenFrom(db, ["a1:m3"]));
    expect(folderOf(db, "a1:m3")).toBe("messages");
  });

  it("tells a hide from a delete that came after it", () => {
    const db = testDb();
    seed(db);
    markHidden(db, ["a1:m1"], () => 10);
    markRestored(db, ["a1:m1"], () => 20);
    markTrashed(db, ["a1:m1"], () => 30);
    expect(hiddenFrom(db, ["a1:m1"]).size).toBe(0);
  });
});

describe("a hidden thread and a new message", () => {
  it("comes back when the other side writes again, and stays hidden when the operator does", async () => {
    const db = testDb();
    seed(db);
    hideThreads(db, ["a1:t1"]);
    const account = db.select().from(accounts).where(eq(accounts.id, "a1")).get()!;
    const incoming = {
      providerMessageId: "INBOX:9",
      providerThreadId: "t1",
      rfcMessageId: null,
      fromAddress: "sale@shop.com",
      fromName: null,
      toAddresses: ["me@example.com"],
      ccAddresses: [],
      subject: "Sale",
      bodyText: "One more thing.",
      bodyHtml: null,
      snippet: null,
      attachmentNames: [],
      attachments: [],
      folder: "inbox" as const,
      sentAt: 600,
      labelIds: [],
    };
    // The operator's own reply, synced from Sent, leaves a hidden thread hidden.
    await storeNormalizedMessage(db, testConfig(), account, { ...incoming, providerMessageId: "SENT:9", fromAddress: "me@example.com", toAddresses: ["sale@shop.com"], folder: "sent", isFromOperator: true }, 601);
    const hiddenAt = () => db.select({ h: threads.hiddenAt }).from(threads).where(eq(threads.id, "a1:t1")).get()?.h ?? null;
    expect(hiddenAt()).not.toBeNull();
    await storeNormalizedMessage(db, testConfig(), account, incoming, 601);
    expect(hiddenAt()).toBeNull();
    expect(folderOf(db, "a1:m1")).toBe("inbox");
  });

  it("leaves a deleted thread in Trash when a new message arrives", async () => {
    const db = testDb();
    seed(db);
    markTrashed(db, ["a1:m1", "a1:m2"]);
    const account = db.select().from(accounts).where(eq(accounts.id, "a1")).get()!;
    await storeNormalizedMessage(
      db,
      testConfig(),
      account,
      { providerMessageId: "INBOX:9", providerThreadId: "t1", rfcMessageId: null, fromAddress: "sale@shop.com", fromName: null, toAddresses: ["me@example.com"], ccAddresses: [], subject: "Sale", bodyText: "Again.", bodyHtml: null, snippet: null, attachmentNames: [], attachments: [], folder: "inbox", sentAt: 600, labelIds: [] },
      601,
    );
    expect(folderOf(db, "a1:m1")).toBe("trash");
  });
});

/**
 * Archive is where archived mail lives, not a thing that can be done twice
 * (operator, 2026-09-20: "you cannot further hide an email"). Re-stamping it
 * moved the thread in the list and rewrote when it was put away, and the row
 * slid out of the list it was already in as if it had gone somewhere.
 */
describe("archiving what is already archived", () => {
  const archived = (db: ReturnType<typeof testDb>, id: string) =>
    db.select({ at: threads.hiddenAt }).from(threads).where(eq(threads.id, id)).get()?.at ?? null;

  it("says nothing moved, and leaves the date it was put away alone", () => {
    const db = testDb();
    seed(db);
    expect(hideThreads(db, ["a1:t1"], () => 100).moved).toBe(1);
    expect(archived(db, "a1:t1")).toBe(100);
    expect(hideThreads(db, ["a1:t1"], () => 500).moved).toBe(0);
    expect(archived(db, "a1:t1")).toBe(100);
  });

  it("still archives the ones that are not, when asked about a mixture", () => {
    const db = testDb();
    seed(db);
    hideThreads(db, ["a1:t1"], () => 100);
    expect(hideThreads(db, ["a1:t1", "a1:t2"], () => 500).moved).toBe(1);
    expect(archived(db, "a1:t1")).toBe(100);
    expect(archived(db, "a1:t2")).toBe(500);
  });

  it("can be put away again once it has been taken out", () => {
    const db = testDb();
    seed(db);
    hideThreads(db, ["a1:t1"], () => 100);
    unhideThreads(db, ["a1:t1"]);
    expect(hideThreads(db, ["a1:t1"], () => 500).moved).toBe(1);
    expect(archived(db, "a1:t1")).toBe(500);
  });
});
