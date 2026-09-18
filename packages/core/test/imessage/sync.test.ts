import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testConfig, testDb } from "../helpers/db";
import { accounts, contacts, messages, threads, watermarks } from "../../src/db/schema";
import { disposableThreadIds, folderCounts, unopenedThreadIds } from "../../src/queue/inbox";
import { hideThreads, restoreThreads, markTrashed } from "../../src/queue/trash";
import type { MailConnector } from "../../src/connectors/types";
import { connectImessageAccount } from "../../src/imessage/account";
import { backfillImessageAccount, contactName, syncImessageAccount } from "../../src/imessage/sync";
import { restoreImessageMessages, trashImessageMessages } from "../../src/imessage/trash";
import type { ImessageSource, TextRow } from "../../src/imessage/types";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);

function text(p: Partial<TextRow> & Pick<TextRow, "rowid" | "guid" | "sentAt">): TextRow {
  return { chatGuid: "iMessage;-;+14155550100", handle: "+14155550100", service: "iMessage", text: `text ${p.rowid}`, isFromMe: false, attachments: [], ...p };
}

function fakeSource(rows: TextRow[]): ImessageSource & { own: TextRow[] } {
  return {
    own: [],
    ownHandle: () => "me@example.com",
    textsAfter: (after, since, limit) => rows.filter((r) => r.rowid > after && (since === null || r.sentAt > since)).slice(0, limit),
    latestOwnText(chatGuid, afterMs) {
      return [...rows].reverse().find((r) => r.chatGuid === chatGuid && r.isFromMe && r.sentAt > afterMs) ?? null;
    },
    contactNames: () => new Map([["4155550100", "Sam Rivera"]]),
    close() {},
  };
}

describe("syncImessageAccount", () => {
  it("reaches 30 days back on the first run, names the chat, and keeps a ROWID watermark", async () => {
    const db = testDb();
    const rows = [
      text({ rowid: 1, guid: "g1", sentAt: NOW - 40 * DAY }),
      text({ rowid: 2, guid: "g2", sentAt: NOW - 2 * DAY, text: "Lunch Friday?" }),
      text({ rowid: 3, guid: "g3", sentAt: NOW - DAY, text: "Sure, noon", isFromMe: true }),
      text({ rowid: 4, guid: "g4", sentAt: NOW - DAY + 1000, text: null, attachments: [] }),
    ];
    const source = fakeSource(rows);
    const account = connectImessageAccount(db, source, () => NOW);
    expect(account.provider).toBe("imessage");
    expect(account.email).toBe("messages:me@example.com");

    const r = await syncImessageAccount(db, testConfig(), source, account, { backfillDays: 7, blocklist: new Set<string>(), clock: () => NOW });
    expect(r).toEqual({ mode: "backfill", fetched: 3, stored: 2, blocked: 0, failed: 0 });

    const stored = db.select().from(messages).orderBy(messages.sentAt).all();
    expect(stored.map((m) => [m.providerMessageId, m.folder, m.isFromOperator, m.subject, m.fromAddress])).toEqual([
      ["g2", "messages", false, "Sam Rivera", "+14155550100"],
      ["g3", "messages", true, "Sam Rivera", "me@example.com"],
    ]);
    const thread = db.select().from(threads).get()!;
    expect(thread.providerThreadId).toBe("iMessage;-;+14155550100");
    expect(thread.lastFromOperator).toBe(true);
    expect(JSON.parse(db.select().from(watermarks).where(eq(watermarks.accountId, account.id)).get()!.historyId)).toEqual({ rowid: 4 });
    expect(contactName(db, "(415) 555-0100")).toBe("Sam Rivera");
    expect(db.select().from(contacts).all()).toHaveLength(1);
    expect(db.select().from(accounts).where(eq(accounts.id, account.id)).get()!.backfilledSince).toBe(NOW - 30 * DAY);

    // The next run reads only past the watermark.
    rows.push(text({ rowid: 5, guid: "g5", sentAt: NOW, text: "See you" }));
    const r2 = await syncImessageAccount(db, testConfig(), source, account, { backfillDays: 7, blocklist: new Set<string>(), clock: () => NOW + 1000 });
    expect(r2).toEqual({ mode: "history", fetched: 1, stored: 1, blocked: 0, failed: 0 });
  });

  it("deletes and restores a chat in our database only", async () => {
    const db = testDb();
    const source = fakeSource([text({ rowid: 1, guid: "g1", sentAt: NOW - DAY }), text({ rowid: 2, guid: "g2", sentAt: NOW, isFromMe: true })]);
    const account = connectImessageAccount(db, source, () => NOW);
    await syncImessageAccount(db, testConfig(), source, account, { backfillDays: 7, blocklist: new Set<string>(), clock: () => NOW });
    const ids = db.select({ id: messages.id }).from(messages).all().map((m) => m.id);
    expect(await trashImessageMessages(db, ids)).toEqual({ moved: 2, failed: 0 });
    expect(db.select({ folder: messages.folder }).from(messages).all().map((m) => m.folder)).toEqual(["trash", "trash"]);
    expect(await restoreImessageMessages(db, ids)).toEqual({ moved: 2, failed: 0 });
    expect(db.select({ folder: messages.folder }).from(messages).all().map((m) => m.folder)).toEqual(["messages", "messages"]);
  });
});

describe("safe to delete, for chats", () => {
  it("is a chat with no name in the address book that the operator never answered", async () => {
    const db = testDb();
    const rows = [
      // A short code, no name, never answered: safe.
      text({ rowid: 1, guid: "g1", sentAt: NOW - DAY, chatGuid: "SMS;-;22395", handle: "22395", service: "SMS", text: "Your code is 481920" }),
      // A friend by name, never answered: not safe.
      text({ rowid: 2, guid: "g2", sentAt: NOW - DAY, text: "Lunch Friday?" }),
      // No name, but the operator wrote back: not safe.
      text({ rowid: 3, guid: "g3", sentAt: NOW - DAY, chatGuid: "iMessage;-;+14155550199", handle: "+14155550199", text: "Hey" }),
      text({ rowid: 4, guid: "g4", sentAt: NOW - DAY + 1000, chatGuid: "iMessage;-;+14155550199", handle: "+14155550199", text: "Hi", isFromMe: true }),
    ];
    const source = fakeSource(rows);
    const account = connectImessageAccount(db, source, () => NOW);
    await syncImessageAccount(db, testConfig(), source, account, { backfillDays: 7, blocklist: new Set<string>(), clock: () => NOW });
    expect(folderCounts(db, { since: 0 }).texts.disposable).toBe(1);
    // Mark all opened on the Messages page acts on chats, not on the inbox.
    // The chat the operator answered is opened by the answer (2026-09-14).
    expect(unopenedThreadIds(db, { folder: "messages" }).length).toBe(2);
    expect(unopenedThreadIds(db, {}).length).toBe(0);
    // The window narrows this row like every other (operator, 2026-09-13).
    expect(folderCounts(db, { since: NOW }).texts.disposable).toBe(0);
    expect(folderCounts(db, { since: NOW }).texts.needsReply).toBe(0);
    const ids = disposableThreadIds(db, { folder: "messages" });
    expect(ids.length).toBe(1);
    const t = db.select().from(threads).where(eq(threads.id, ids[0]!)).get()!;
    expect(t.subject).toBe("22395");
  });
});

describe("trashImessageMessages, through Messages.app", () => {
  async function twoChats() {
    const db = testDb();
    const rows = [
      text({ rowid: 1, guid: "g1", sentAt: NOW - DAY, text: "Lunch?" }),
      text({ rowid: 2, guid: "g2", sentAt: NOW - DAY + 1000, text: "Noon?" }),
      text({ rowid: 3, guid: "g3", sentAt: NOW - DAY, chatGuid: "SMS;-;22395", handle: "22395", service: "SMS", text: "Your code is 1" }),
    ];
    const source = fakeSource(rows);
    const account = connectImessageAccount(db, source, () => NOW);
    await syncImessageAccount(db, testConfig(), source, account, { backfillDays: 7, blocklist: new Set<string>(), clock: () => NOW });
    return { db, ids: db.select({ id: messages.id }).from(messages).all().map((r) => r.id) };
  }

  it("deletes each chat once in Messages.app and hides its texts here", async () => {
    const { db, ids } = await twoChats();
    const deleted: string[] = [];
    const subjects: string[] = [];
    const r = await trashImessageMessages(db, ids, { deleteChat: async (chat) => void (deleted.push(chat.handle), subjects.push(chat.subject)) });
    expect(r).toEqual({ moved: 3, failed: 0 });
    expect(deleted.sort()).toEqual(["+14155550100", "22395"]);
    // The chat's name travels with it, for checking Messages opened the right window.
    expect(subjects.sort()).toEqual(["22395", "Sam Rivera"]);
    expect(db.select().from(messages).where(eq(messages.folder, "trash")).all().length).toBe(3);
  });

  it("keeps a chat Messages.app would not delete, and says so in the count", async () => {
    const { db, ids } = await twoChats();
    const r = await trashImessageMessages(db, ids, {
      deleteChat: async (chat) => {
        if (chat.handle === "22395") throw new Error("no window");
      },
    });
    expect(r).toEqual({ moved: 2, failed: 1 });
    const kept = db.select().from(messages).where(eq(messages.folder, "messages")).all();
    expect(kept.map((m) => m.fromAddress)).toEqual(["22395"]);
  });

  it("only hides the texts when there is nothing to drive Messages.app with", async () => {
    const { db, ids } = await twoChats();
    expect(await trashImessageMessages(db, ids)).toEqual({ moved: 3, failed: 0 });
  });
});

describe("backfillImessageAccount", () => {
  it("reaches back to the start of the chat, storing what the first sync left out and nothing twice", async () => {
    const db = testDb();
    const rows = [
      text({ rowid: 1, guid: "g1", sentAt: NOW - 100 * DAY, text: "old" }),
      text({ rowid: 2, guid: "g2", sentAt: NOW - 40 * DAY, text: "older" }),
      text({ rowid: 3, guid: "g3", sentAt: NOW - DAY, text: "recent" }),
    ];
    const source = fakeSource(rows);
    const account = connectImessageAccount(db, source, () => NOW);
    await syncImessageAccount(db, testConfig(), source, account, { backfillDays: 30, blocklist: new Set<string>(), clock: () => NOW });
    expect(db.select().from(messages).all().length).toBe(1);
    const r = await backfillImessageAccount(db, testConfig(), source, account, { to: null, blocklist: new Set<string>(), clock: () => NOW });
    expect(r).toEqual({ mode: "backfill", fetched: 3, stored: 2, blocked: 0, failed: 0 });
    expect(db.select().from(messages).all().length).toBe(3);
    expect(db.select().from(accounts).where(eq(accounts.id, account.id)).get()?.backfilledSince).toBe(0);
  });
});

describe("a hidden chat stays in Messages", () => {
  it("keeps every text where it is, and undo unhides the chat (2026-09-15)", async () => {
    const db = testDb();
    const rows = [
      text({ rowid: 1, guid: "g1", sentAt: NOW - DAY, text: "Lunch?" }),
      text({ rowid: 2, guid: "g2", sentAt: NOW - DAY + 1000, text: "Sure", isFromMe: true }),
    ];
    const source = fakeSource(rows);
    const account = connectImessageAccount(db, source, () => NOW);
    await syncImessageAccount(db, testConfig(), source, account, { backfillDays: 7, blocklist: new Set<string>(), clock: () => NOW });
    const thread = db.select().from(threads).get()!;
    expect(hideThreads(db, [thread.id])).toEqual({ moved: 1, failed: 0 });
    expect(db.select().from(messages).where(eq(messages.folder, "messages")).all().length).toBe(2);
    const connectorFor = (): MailConnector => ({ restore: (rdb: never, _a: never, ids: string[]) => restoreImessageMessages(rdb, ids) }) as unknown as MailConnector;
    expect(await restoreThreads(db, connectorFor, [thread.id])).toEqual({ moved: 1, failed: 0 });
    expect(db.select().from(threads).get()?.hiddenAt).toBeNull();
  });
});

describe("a backfill leaves a deleted chat deleted", () => {
  it("files the older texts of a chat deleted here in Trash, and a live chat's in Messages", async () => {
    const db = testDb();
    const rows = [
      text({ rowid: 1, guid: "g1", sentAt: NOW - 100 * DAY, text: "old" }),
      text({ rowid: 2, guid: "g2", sentAt: NOW - DAY, text: "recent" }),
      text({ rowid: 3, guid: "g3", sentAt: NOW - 100 * DAY, chatGuid: "SMS;-;22395", handle: "22395", service: "SMS", text: "old code" }),
      text({ rowid: 4, guid: "g4", sentAt: NOW - DAY, chatGuid: "SMS;-;22395", handle: "22395", service: "SMS", text: "new code" }),
    ];
    const source = fakeSource(rows);
    const account = connectImessageAccount(db, source, () => NOW);
    await syncImessageAccount(db, testConfig(), source, account, { backfillDays: 30, blocklist: new Set<string>(), clock: () => NOW });
    const code = db.select().from(threads).where(eq(threads.providerThreadId, "SMS;-;22395")).get()!;
    markTrashed(db, db.select({ id: messages.id }).from(messages).where(eq(messages.threadId, code.id)).all().map((r) => r.id));
    await backfillImessageAccount(db, testConfig(), source, account, { to: null, blocklist: new Set<string>(), clock: () => NOW });
    const folders = (guid: string) => db.select({ folder: messages.folder }).from(messages).where(eq(messages.providerMessageId, guid)).get()?.folder;
    expect(folders("g3")).toBe("trash");
    expect(folders("g1")).toBe("messages");
  });
});

/** A contact added after the chat was stored names it on the next sync (2026-09-14). */
describe("syncImessageAccount: names learned later", () => {
  it("renames a chat stored by its number once Contacts has a name for it", async () => {
    const db = testDb();
    const rows = [text({ rowid: 1, guid: "g1", sentAt: NOW - DAY, chatGuid: "iMessage;-;+12025550123", handle: "+12025550123", text: "hi" })];
    const source = fakeSource(rows);
    const account = connectImessageAccount(db, source, () => NOW);
    await syncImessageAccount(db, testConfig(), source, account, { backfillDays: 7, blocklist: new Set<string>(), clock: () => NOW });
    expect(db.select().from(threads).get()?.subject).toBe("+12025550123");
    const later = { ...source, contactNames: () => new Map([["2025550123", "Dana Cole"]]) };
    await syncImessageAccount(db, testConfig(), later, account, { backfillDays: 7, blocklist: new Set<string>(), clock: () => NOW + 1000 });
    expect(db.select().from(threads).get()?.subject).toBe("Dana Cole");
    expect(db.select().from(messages).get()).toMatchObject({ subject: "Dana Cole", fromName: "Dana Cole" });
  });
});

/** What Messages says was read is read here (operator, 2026-09-14). */
describe("syncImessageAccount: read in Messages", () => {
  it("a text already read arrives opened, and one read on the phone later opens on the next sync", async () => {
    const db = testDb();
    const rows = [
      text({ rowid: 1, guid: "g1", sentAt: NOW - DAY, text: "read already", isRead: true }),
      text({ rowid: 2, guid: "g2", sentAt: NOW - DAY, chatGuid: "iMessage;-;+12025550123", handle: "+12025550123", text: "not yet", isRead: false }),
    ];
    const source = { ...fakeSource(rows), readGuidsSince: () => [] as string[] };
    const account = connectImessageAccount(db, source, () => NOW);
    await syncImessageAccount(db, testConfig(), source, account, { backfillDays: 7, blocklist: new Set<string>(), clock: () => NOW });
    expect(unopenedThreadIds(db, { folder: "messages" })).toEqual([`${account.id}:iMessage;-;+12025550123`]);
    const later = { ...source, readGuidsSince: () => ["g2"] };
    await syncImessageAccount(db, testConfig(), later, account, { backfillDays: 7, blocklist: new Set<string>(), clock: () => NOW + 1000 });
    expect(unopenedThreadIds(db, { folder: "messages" })).toEqual([]);
  });
});
