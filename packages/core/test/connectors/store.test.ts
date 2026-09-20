import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { accountRow, testDb } from "../helpers/db";
import { accounts, actions, attachments, messages, threadOpens, threads, type AccountRow } from "../../src/db/schema";
import { markTrashed, markHidden } from "../../src/queue/trash";
import { storeNormalizedMessage, storeSentReply, messageRowId, threadRowId } from "../../src/connectors/store";
import type { Config } from "../../src/config";
import type { NormalizedAttachment, NormalizedMessage } from "../../src/connectors/types";

let dir: string;
let cfg: Config;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "store-test-"));
  cfg = { blobsDir: path.join(dir, "blobs") } as Config;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function att(overrides: Partial<NormalizedAttachment> = {}): NormalizedAttachment {
  return { index: 0, filename: "menu.pdf", mimeType: "application/pdf", size: 4, providerAttachmentId: null, bytes: Buffer.from("PDF!"), ...overrides };
}

function seedAccount(db: ReturnType<typeof testDb>): AccountRow {
  const row = accountRow({ id: "a1", provider: "imap", email: "me@example.com" });
  db.insert(accounts).values(row).run();
  return row;
}

function n(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    providerMessageId: "m1",
    providerThreadId: "t1",
    rfcMessageId: "<m1@x>",
    fromAddress: "bob@example.com",
    fromName: "Bob",
    toAddresses: ["me@example.com"],
    ccAddresses: [],
    subject: "Hi",
    bodyText: "hello",
    bodyHtml: null,
    snippet: "hello",
    attachmentNames: [],
    attachments: [],
    folder: "inbox",
    sentAt: 100,
    labelIds: [],
    ...overrides,
  };
}

describe("messageRowId / threadRowId", () => {
  it("namespaces provider ids by account", () => {
    expect(messageRowId("a1", "m1")).toBe("a1:m1");
    expect(threadRowId("a1", "t1")).toBe("a1:t1");
  });
});

describe("storeNormalizedMessage", () => {
  it("inserts a new message and thread, returning true", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    const stored = await storeNormalizedMessage(db, cfg, acct, n(), 500);
    expect(stored).toBe(true);
    const m = db.select().from(messages).where(eq(messages.id, "a1:m1")).get();
    expect(m).toMatchObject({ fromAddress: "bob@example.com", isFromOperator: false, receivedAt: 500, bodyHtml: null });
    const t = db.select().from(threads).where(eq(threads.id, "a1:t1")).get();
    expect(t).toMatchObject({ lastMessageAt: 100, lastFromOperator: false });
  });

  it("is idempotent: re-storing the same provider message id returns false and does not duplicate", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    expect(await storeNormalizedMessage(db, cfg, acct, n(), 500)).toBe(true);
    expect(await storeNormalizedMessage(db, cfg, acct, n(), 600)).toBe(false);
    expect(db.select().from(messages).all()).toHaveLength(1);
  });

  it("stores a sanitized bodyHtml when the normalized message carries one", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    await storeNormalizedMessage(db, cfg, acct, n({ bodyHtml: "<p>hello</p>" }), 500);
    const m = db.select().from(messages).where(eq(messages.id, "a1:m1")).get();
    expect(m?.bodyHtml).toBe("<p>hello</p>");
  });

  it("marks isFromOperator when the from address matches the account email", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "m2", fromAddress: "me@example.com" }), 1);
    expect(db.select().from(messages).where(eq(messages.id, "a1:m2")).get()?.isFromOperator).toBe(true);
  });

  it("advances thread lastMessageAt/lastFromOperator only forward in time", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "m1", sentAt: 300, fromAddress: "bob@example.com" }), 1);
    await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "m0", sentAt: 100, fromAddress: "me@example.com" }), 2);
    const t = db.select().from(threads).where(eq(threads.id, "a1:t1")).get();
    expect(t?.lastMessageAt).toBe(300);
    expect(t?.lastFromOperator).toBe(false);
  });
});

describe("storeNormalizedMessage reconciliation", () => {
  it("moves a row's location instead of inserting a duplicate when the app trashed it (spec 10a, 2026-09-11)", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "INBOX:1", folder: "inbox" }), 500);

    // The Outlook/Gmail app moved it to Trash under a fresh id; the next
    // sync sees that as an ordinary incoming message.
    const stored = await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "TRASH:9", folder: "trash" }), 600);

    expect(stored).toBe(false);
    const rows = db.select().from(messages).all();
    expect(rows).toHaveLength(1);
    // `id` is fixed at insert time from the original provider id; only the
    // location columns move (spec 10a, 2026-09-11).
    expect(rows[0]).toMatchObject({ id: "a1:INBOX:1", providerMessageId: "TRASH:9", folder: "trash" });
  });

  it("knows a message it moved itself when the sync meets it under the new provider id", async () => {
    // Seen live, 2026-09-11: the row restored by Cmd-Z kept its id and took
    // the new provider id; the next sync inserted the message again.
    const db = testDb();
    const acct = seedAccount(db);
    await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "INBOX:1", folder: "inbox" }), 500);
    db.update(messages).set({ providerMessageId: "INBOX:2", folder: "inbox" }).where(eq(messages.id, "a1:INBOX:1")).run();

    const stored = await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "INBOX:2", folder: "inbox" }), 600);

    expect(stored).toBe(false);
    const rows = db.select().from(messages).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "a1:INBOX:1", providerMessageId: "INBOX:2", folder: "inbox" });
  });

  it("reconciles a restore the same way, moving Trash back to Inbox", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "TRASH:9", folder: "trash" }), 500);

    const stored = await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "INBOX:2", folder: "inbox" }), 600);

    expect(stored).toBe(false);
    const rows = db.select().from(messages).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "a1:TRASH:9", providerMessageId: "INBOX:2", folder: "inbox" });
  });

  it("does not reconcile when neither side is Trash (a self-sent message legitimately sits in two folders)", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "INBOX:1", folder: "inbox" }), 500);

    const stored = await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "SENT:1", folder: "sent" }), 600);

    expect(stored).toBe(true);
    expect(db.select().from(messages).all()).toHaveLength(2);
  });

  it("does not reconcile when both sides are already Trash", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "TRASH:1", folder: "trash" }), 500);

    const stored = await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "TRASH:2", folder: "trash" }), 600);

    expect(stored).toBe(true);
    expect(db.select().from(messages).all()).toHaveLength(2);
  });

  it("does not reconcile across accounts, and not without a Message-ID", async () => {
    const db = testDb();
    const a1 = seedAccount(db);
    const a2Row = accountRow({ id: "a2", provider: "imap", email: "other@example.com" });
    db.insert(accounts).values(a2Row).run();

    await storeNormalizedMessage(db, cfg, a1, n({ providerMessageId: "INBOX:1", folder: "inbox" }), 500);
    expect(await storeNormalizedMessage(db, cfg, a2Row, n({ providerMessageId: "TRASH:1", folder: "trash" }), 600)).toBe(true);
    expect(db.select().from(messages).all()).toHaveLength(2);

    expect(
      await storeNormalizedMessage(db, cfg, a1, n({ providerMessageId: "TRASH:2", folder: "trash", rfcMessageId: null, providerThreadId: "t2" }), 700),
    ).toBe(true);
    expect(db.select().from(messages).all()).toHaveLength(3);
  });
});

describe("storeNormalizedMessage attachments", () => {
  it("writes the bytes to a blob and records sha256, path and fetchedAt", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    await storeNormalizedMessage(db, cfg, acct, n({ attachmentNames: ["menu.pdf"], attachments: [att()] }), 500);

    const rows = db.select().from(attachments).all();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      id: "a1:m1:0",
      messageId: "a1:m1",
      index: 0,
      filename: "menu.pdf",
      mimeType: "application/pdf",
      size: 4,
      providerAttachmentId: null,
      fetchedAt: 500,
    });
    expect(row.sha256).toBe(createHash("sha256").update("PDF!").digest("hex"));
    expect(await readFile(row.path!)).toEqual(Buffer.from("PDF!"));
  });

  it("leaves sha256/path/fetchedAt null when the provider gave no bytes", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    const graph = att({ bytes: null, providerAttachmentId: "att1" });
    await storeNormalizedMessage(db, cfg, acct, n({ attachmentNames: ["menu.pdf"], attachments: [graph] }), 500);

    const row = db.select().from(attachments).get()!;
    expect(row.providerAttachmentId).toBe("att1");
    expect(row.sha256).toBeNull();
    expect(row.path).toBeNull();
    expect(row.fetchedAt).toBeNull();
  });

  it("inserts one row per kept attachment, keyed by message id and index", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    const two = [att(), att({ index: 1, filename: "receipt.png", mimeType: "image/png", bytes: Buffer.from("PNG!") })];
    await storeNormalizedMessage(db, cfg, acct, n({ attachmentNames: ["menu.pdf", "receipt.png"], attachments: two }), 500);
    expect(db.select().from(attachments).all().map((r) => r.id)).toEqual(["a1:m1:0", "a1:m1:1"]);
  });

  it("does not duplicate attachment rows when the same message arrives twice", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    const msg = n({ attachmentNames: ["menu.pdf"], attachments: [att()] });
    await storeNormalizedMessage(db, cfg, acct, msg, 500);
    await storeNormalizedMessage(db, cfg, acct, msg, 600);
    expect(db.select().from(attachments).all()).toHaveLength(1);
  });

  it("keeps the message when a blob write fails, leaving the row unfetched", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // A blobsDir under a regular file: mkdir -p cannot succeed.
    const file = path.join(dir, "not-a-dir");
    await writeFile(file, "x");
    const broken = { blobsDir: path.join(file, "blobs") } as Config;

    const stored = await storeNormalizedMessage(db, broken, acct, n({ attachmentNames: ["menu.pdf"], attachments: [att()] }), 500);
    expect(stored).toBe(true);
    expect(db.select().from(messages).all()).toHaveLength(1);
    const row = db.select().from(attachments).get()!;
    expect(row.path).toBeNull();
    expect(row.fetchedAt).toBeNull();
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});

/** Mail the provider says was read arrives opened up to itself (2026-09-14). */
describe("storeNormalizedMessage: read elsewhere", () => {
  const opens = (db: ReturnType<typeof testDb>) => Object.fromEntries(db.select().from(threadOpens).all().map((r) => [r.threadId, r.openedAt]));

  it("opens the thread up to a read message, and not for an unread or unknown one", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    await storeNormalizedMessage(db, cfg, acct, n({ read: true }), 500);
    expect(opens(db)).toEqual({ "a1:t1": 100 });
    await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "m2", providerThreadId: "t2", read: false }), 500);
    await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "m3", providerThreadId: "t3" }), 500);
    expect(opens(db)).toEqual({ "a1:t1": 100 });
  });

  it("a delta saying an existing message was read since still opens its thread", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    expect(await storeNormalizedMessage(db, cfg, acct, n({ read: false }), 500)).toBe(true);
    expect(opens(db)).toEqual({});
    expect(await storeNormalizedMessage(db, cfg, acct, n({ read: true }), 600)).toBe(false);
    expect(opens(db)).toEqual({ "a1:t1": 100 });
  });

  it("the operator's own message opens the thread up to it, read flag or not (2026-09-14)", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "in1", rfcMessageId: "<in1@x>", sentAt: 100 }), 500);
    expect(opens(db)).toEqual({});
    // Answered from another app: the reply lands, and the thread is read up to it.
    await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "out1", rfcMessageId: "<out1@x>", fromAddress: "me@example.com", folder: "sent", sentAt: 200 }), 500);
    expect(opens(db)).toEqual({ "a1:t1": 200 });
    // Something newer from them makes it unread again.
    await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "in2", rfcMessageId: "<in2@x>", sentAt: 300 }), 500);
    expect(opens(db)).toEqual({ "a1:t1": 200 });
  });
});

/**
 * Mail arrives where the operator reads it (operator, 2026-09-20:
 * "everything should appear inside inbox or unopened").
 *
 * There used to be a rule that put mail from a previously-deleted, never-
 * answered sender straight into Deleted items. Delete all marks every sender
 * in a sweep at once, so it silenced 285 of them and swallowed 316 messages,
 * invisibly. Safe to Delete already answers this, in a list that can be seen.
 */
describe("storeNormalizedMessage: nothing is hidden on arrival", () => {
  const folderOf = (db: ReturnType<typeof testDb>, id: string) => db.select({ folder: messages.folder }).from(messages).where(eq(messages.id, id)).get()?.folder;

  it("puts a new message in the inbox even when that sender's mail was deleted before", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "m1", providerThreadId: "t1", rfcMessageId: "<c1@x>", fromAddress: "codes@shortcode.test" }), 500);
    markTrashed(db, ["a1:m1"], () => 600);
    expect(await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "m2", providerThreadId: "t2", rfcMessageId: "<c2@x>", fromAddress: "Codes@shortcode.test", sentAt: 700 }), 700)).toBe(true);
    expect(folderOf(db, "a1:m2")).toBe("inbox");
    // Nothing hid it, so nothing recorded hiding it.
    expect(db.select().from(actions).where(eq(actions.messageId, "a1:m2")).all()).toEqual([]);
    // And it is unopened: it arrived where the operator reads, unread.
    expect(db.select().from(threadOpens).all()).toEqual([]);
  });

  it("leaves a sender the operator has written to alone, and one they only hid", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    // Deleted once, but answered in another thread: a person.
    await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "m1", providerThreadId: "t1", rfcMessageId: "<b1@x>", fromAddress: "bob@example.com" }), 500);
    await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "s1", providerThreadId: "t1", rfcMessageId: "<s1@x>", fromAddress: "me@example.com", toAddresses: ["bob@example.com"], folder: "sent" }), 500);
    markTrashed(db, ["a1:m1"], () => 600);
    await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "m2", providerThreadId: "t2", rfcMessageId: "<b2@x>", fromAddress: "bob@example.com", sentAt: 700 }), 700);
    expect(folderOf(db, "a1:m2")).toBe("inbox");
    // Hidden, not deleted: comes back with the next message, as before.
    await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "m3", providerThreadId: "t3", rfcMessageId: "<n3@x>", fromAddress: "news@example.com" }), 500);
    markHidden(db, ["a1:m3"], () => 600);
    await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "m4", providerThreadId: "t3", rfcMessageId: "<n4@x>", fromAddress: "news@example.com", sentAt: 700 }), 700);
    expect(folderOf(db, "a1:m3")).toBe("inbox");
    expect(folderOf(db, "a1:m4")).toBe("inbox");
  });
});

/**
 * Hidden here, then deleted in the provider's own app (2026-09-14): the copy
 * that lands in Trash is the same message, and a hidden thread never comes
 * back for a copy landing in Trash or Junk.
 */
describe("storeNormalizedMessage: hidden, then deleted in the provider", () => {
  it("files the provider's Trash copy on the hidden row, as deleted, without a second row or a resurrection", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "old-id", rfcMessageId: "<sale@shop>", fromAddress: "sale@shop.com" }), 500);
    markHidden(db, ["a1:old-id"], () => 600);
    expect(await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "new-id", rfcMessageId: "<sale@shop>", fromAddress: "sale@shop.com", folder: "trash" }), 700)).toBe(false);
    const rows = db.select().from(messages).all();
    expect(rows.map((r) => [r.id, r.providerMessageId, r.folder])).toEqual([["a1:old-id", "new-id", "trash"]]);
    expect(db.select().from(actions).where(eq(actions.messageId, "a1:old-id")).all().map((a) => a.kind)).toEqual(["hide", "trash"]);
  });

  it("a different message landing in Trash or Junk does not bring a hidden thread back; one in the inbox does", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "m1", rfcMessageId: "<a@x>" }), 500);
    markHidden(db, ["a1:m1"], () => 600);
    await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "m2", rfcMessageId: "<b@x>", folder: "junk", sentAt: 200 }), 700);
    expect(db.select({ f: messages.folder }).from(messages).where(eq(messages.id, "a1:m1")).get()?.f).toBe("trash");
    await storeNormalizedMessage(db, cfg, acct, n({ providerMessageId: "m3", rfcMessageId: "<c@x>", folder: "inbox", sentAt: 300 }), 800);
    expect(db.select({ f: messages.folder }).from(messages).where(eq(messages.id, "a1:m1")).get()?.f).toBe("inbox");
  });
});

describe("storeSentReply: the sent reply shows at once (2026-09-15)", () => {
  const sent = (account: AccountRow, overrides: Partial<Parameters<typeof storeSentReply>[2]> = {}) =>
    storeSentReply(testDbRef, cfg, {
      account,
      providerThreadId: "t1",
      draftId: "d1",
      subject: "Re: Hi",
      to: ["bob@example.com"],
      cc: [],
      text: "Thanks Bob, here is my address.",
      attachmentNames: [],
      rfcMessageId: "<sent1@example.com>",
      sentAt: 1_000_000,
      ...overrides,
    });
  let testDbRef: ReturnType<typeof testDb>;

  it("puts the reply in its thread as the operator's, and the thread reads as answered", async () => {
    testDbRef = testDb();
    const account = seedAccount(testDbRef);
    await storeNormalizedMessage(testDbRef, cfg, account, n({ sentAt: 900_000 }), 900_000);
    await sent(account);
    const rows = testDbRef.select().from(messages).where(eq(messages.threadId, threadRowId("a1", "t1"))).all();
    expect(rows.map((r) => [r.folder, r.isFromOperator, r.bodyText])).toEqual([
      ["inbox", false, "hello"],
      ["sent", true, "Thanks Bob, here is my address."],
    ]);
    expect(testDbRef.select().from(threads).where(eq(threads.id, threadRowId("a1", "t1"))).get()?.lastFromOperator).toBe(true);
  });

  it("is taken over by the provider's copy with the same Message-ID, not shown twice", async () => {
    testDbRef = testDb();
    const account = seedAccount(testDbRef);
    await sent(account);
    const before = testDbRef.select().from(messages).all();
    const inserted = await storeNormalizedMessage(
      testDbRef,
      cfg,
      account,
      n({ providerMessageId: "sent:77", rfcMessageId: "<sent1@example.com>", fromAddress: "me@example.com", folder: "sent", bodyText: "Thanks Bob, here is my address.\n\nOn Tue Bob wrote: hello", sentAt: 1_000_400 }),
      1_000_500,
    );
    const rows = testDbRef.select().from(messages).all();
    expect(inserted).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(before[0]!.id);
    expect(rows[0]!.providerMessageId).toBe("sent:77");
    expect(rows[0]!.bodyText).toContain("On Tue Bob wrote");
  });

  it("where the send gives no Message-ID (Outlook), is taken over by the operator's copy in the same thread that starts with the reply", async () => {
    testDbRef = testDb();
    const account = seedAccount(testDbRef);
    await sent(account, { rfcMessageId: null });
    await storeNormalizedMessage(
      testDbRef,
      cfg,
      account,
      n({ providerMessageId: "AAMk-sent", rfcMessageId: "<outlook@x>", fromAddress: "me@example.com", folder: "sent", bodyText: "Thanks  Bob,\nhere is my address.\r\n\r\nFrom: Bob", sentAt: 1_060_000 }),
      1_060_000,
    );
    const rows = testDbRef.select().from(messages).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.providerMessageId).toBe("AAMk-sent");
  });

  it("leaves another message of the operator's alone: a different reply, another thread, or long after", async () => {
    testDbRef = testDb();
    const account = seedAccount(testDbRef);
    await sent(account, { rfcMessageId: null });
    const mine = (o: Partial<NormalizedMessage>) =>
      storeNormalizedMessage(testDbRef, cfg, account, n({ fromAddress: "me@example.com", folder: "sent", rfcMessageId: null, ...o }), 1_000_000);
    await mine({ providerMessageId: "x1", bodyText: "Something else entirely", sentAt: 1_000_100 });
    await mine({ providerMessageId: "x2", providerThreadId: "t2", bodyText: "Thanks Bob, here is my address.", sentAt: 1_000_100 });
    await mine({ providerMessageId: "x3", bodyText: "Thanks Bob, here is my address.", sentAt: 1_000_000 + 2 * 60 * 60_000 });
    expect(testDbRef.select().from(messages).all()).toHaveLength(4);
  });

  it("stores nothing for a chat, whose sync reads the text back at once", async () => {
    testDbRef = testDb();
    const row = accountRow({ id: "im", provider: "imessage", email: "imessage" });
    testDbRef.insert(accounts).values(row).run();
    await sent(row);
    expect(testDbRef.select().from(messages).all()).toHaveLength(0);
  });
});
