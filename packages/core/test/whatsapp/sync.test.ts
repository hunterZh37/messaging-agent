import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testConfig, testDb } from "../helpers/db";
import { accounts, messages, threadOpens, threads } from "../../src/db/schema";
import { connectWhatsappAccount } from "../../src/whatsapp/account";
import { backfillWhatsappAccount, syncWhatsappAccount } from "../../src/whatsapp/sync";
import { disposableThreadIds, folderCounts, listInboxMessages } from "../../src/queue/inbox";
import { trashImessageMessages } from "../../src/imessage/trash";
import { sendText } from "../../src/imessage/compose";
import type { WaChat, WaMessage, WhatsappSource } from "../../src/whatsapp/types";
import type { Sender } from "../../src/connectors/types";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);
const ada: WaChat = { jid: "14155550111@s.whatsapp.net", name: "Ada Lovelace", kind: "person", phone: "14155550111" };
const code: WaChat = { jid: "12345@s.whatsapp.net", name: "12345", kind: "person", phone: "12345" };
const standup: WaChat = { jid: "120363100000000001@g.us", name: "Team Standup", kind: "group", phone: null };

function m(p: Partial<WaMessage> & Pick<WaMessage, "pk" | "sentAt">): WaMessage {
  return { stanzaId: `S${p.pk}`, chat: ada, text: `text ${p.pk}`, isFromMe: false, senderJid: ada.jid, senderName: ada.name, media: null, ...p };
}

function fake(rows: WaMessage[]): WhatsappSource {
  return {
    own: () => ({ jid: "12025550100@s.whatsapp.net", lid: "20250000000001@lid", phone: "12025550100" }),
    messagesAfter: (after, since, limit) => rows.filter((r) => r.pk > after && (since === null || r.sentAt > since)).slice(0, limit),
    latestOwnMessage: () => null,
    chatState: () => ({ exists: true, removed: false, count: 1 }),
    chat: (jid) => [ada, code, standup].find((c) => c.jid === jid) ?? null,
    pushNames: () => new Map([["20250000000002@lid", "Alan Turing"]]),
    contactNames: () => new Map([["4155550100", "Sam Rivera"]]),
    close() {},
  };
}

async function synced(rows: WaMessage[]) {
  const db = testDb();
  const source = fake(rows);
  const account = connectWhatsappAccount(db, source, () => NOW);
  const r = await syncWhatsappAccount(db, testConfig(), source, account, { backfillDays: 30, blocklist: new Set<string>(), clock: () => NOW });
  return { db, account, r };
}

describe("syncWhatsappAccount", () => {
  it("reaches 30 days back, names chats and senders, and keeps a row watermark", async () => {
    const { db, account, r } = await synced([
      m({ pk: 1, sentAt: NOW - 40 * DAY }),
      m({ pk: 2, sentAt: NOW - 2 * DAY, text: "Lunch?" }),
      m({ pk: 3, sentAt: NOW - DAY, text: "Noon", isFromMe: true, senderJid: null, senderName: null }),
      m({ pk: 4, sentAt: NOW - DAY, chat: standup, senderJid: "20250000000002@lid", senderName: "Alan Turing", text: "@20250000000001 in?" }),
      m({ pk: 5, sentAt: NOW - DAY, text: null }),
    ]);
    expect(account.email).toBe("whatsapp:12025550100");
    expect(r).toEqual({ mode: "backfill", fetched: 4, stored: 3, blocked: 0, failed: 0 });
    const t = db.select().from(threads).all().map((x) => x.subject).sort();
    expect(t).toEqual(["Ada Lovelace", "Team Standup"]);
    const group = db.select().from(messages).where(eq(messages.mentionsOperator, true)).get()!;
    expect(group.bodyText).toBe("@you in?");
    expect(group.fromName).toBe("Alan Turing");
  });

  it("puts a person's last word and a mention in a group under Need to reply, and never a group under Safe to delete", async () => {
    const { db } = await synced([
      m({ pk: 1, sentAt: NOW - DAY, text: "Lunch?" }),
      m({ pk: 2, sentAt: NOW - DAY, chat: standup, senderJid: "20250000000002@lid", senderName: "Alan Turing", text: "@20250000000001 in?" }),
      m({ pk: 3, sentAt: NOW - DAY, chat: code, senderJid: code.jid, senderName: code.name, text: "Your code is 1234" }),
    ]);
    // The short code is nobody the operator knows (2026-09-14): Safe to delete, never Need to reply.
    const need = listInboxMessages(db, { folder: "messages", status: "needs_reply", now: NOW }).map((r) => r.thread.subject).sort();
    expect(need).toEqual(["Ada Lovelace", "Team Standup"]);
    expect(disposableThreadIds(db, { folder: "messages" }).length).toBe(1);
    expect(folderCounts(db, { since: 0, now: NOW }).texts).toEqual({ needsReply: 2, unopened: 3, disposable: 1, hidden: 0 });
  });

  it("leaves a group out of Need to reply when nobody mentioned the operator", async () => {
    const { db } = await synced([m({ pk: 1, sentAt: NOW - DAY, chat: standup, senderJid: "20250000000002@lid", senderName: "Alan Turing", text: "anyone?" })]);
    expect(folderCounts(db, { since: 0 }).texts.needsReply).toBe(0);
  });

  it("texts a group by its chat, and deletes chat by chat", async () => {
    const { db } = await synced([m({ pk: 1, sentAt: NOW - DAY, chat: standup, senderJid: "20250000000002@lid", senderName: "Alan Turing", text: "anyone?" })]);
    const thread = db.select().from(threads).get()!;
    const to: string[][] = [];
    const sender: Sender = { sendReply: async (p) => (to.push(p.to), { id: "ok" }) };
    await sendText(db, sender, { threadId: thread.id, text: "me" }, () => NOW);
    expect(to).toEqual([[standup.jid]]);
    const deleted: string[] = [];
    const ids = db.select({ id: messages.id }).from(messages).all().map((r) => r.id);
    await trashImessageMessages(db, ids, { deleteChat: async (c) => void deleted.push(`${c.guid}|${c.subject}`) });
    expect(deleted).toEqual([`${standup.jid}|Team Standup`]);
  });
});

describe("backfillWhatsappAccount", () => {
  it("reaches back to the start, storing what the first sync left out and nothing twice", async () => {
    const db = testDb();
    const rows = [m({ pk: 1, sentAt: NOW - 100 * DAY, text: "old" }), m({ pk: 2, sentAt: NOW - 40 * DAY, text: "older" }), m({ pk: 3, sentAt: NOW - DAY, text: "recent" })];
    const source = fake(rows);
    const account = connectWhatsappAccount(db, source, () => NOW);
    await syncWhatsappAccount(db, testConfig(), source, account, { backfillDays: 30, blocklist: new Set<string>(), clock: () => NOW });
    expect(db.select().from(messages).all().length).toBe(1);
    const r = await backfillWhatsappAccount(db, testConfig(), source, account, { to: null, blocklist: new Set<string>(), clock: () => NOW });
    expect(r).toEqual({ mode: "backfill", fetched: 3, stored: 2, blocked: 0, failed: 0 });
    expect(db.select().from(messages).all().length).toBe(3);
  });
});

/** A chat WhatsApp only knows by number takes its name from Contacts on this Mac (2026-09-14). */
describe("syncWhatsappAccount: names from Contacts", () => {
  const stranger: WaChat = { jid: "14155550100@s.whatsapp.net", name: "\u202a+1 (415) 555\u20110100\u202c", kind: "person", phone: "14155550100" };
  it("names the chat from Contacts at store time, and renames one stored before Contacts knew", async () => {
    const { db } = await synced([m({ pk: 1, sentAt: NOW - DAY, chat: stranger, senderJid: stranger.jid, senderName: null, text: "hey" })]);
    expect(db.select().from(threads).all().map((t) => t.subject)).toEqual(["Sam Rivera"]);
    // Stored under the number by an older build: the next sync renames it.
    db.update(threads).set({ subject: stranger.name }).run();
    db.update(messages).set({ subject: stranger.name, fromName: null }).run();
    const source = fake([]);
    const account = db.select().from(accounts).get()!;
    await syncWhatsappAccount(db, testConfig(), source, account, { backfillDays: 30, blocklist: new Set<string>(), clock: () => NOW });
    expect(db.select().from(threads).all().map((t) => t.subject)).toEqual(["Sam Rivera"]);
    expect(db.select().from(messages).all().map((r) => [r.subject, r.fromName])).toEqual([["Sam Rivera", "Sam Rivera"]]);
  });
});

/** A chat WhatsApp counts no unread in is read here (operator, 2026-09-14). */
describe("syncWhatsappAccount: read in WhatsApp", () => {
  it("opens a chat with no unread texts, leaves one with unread alone, and catches up a chat read later", async () => {
    const db = testDb();
    const rows = [
      m({ pk: 1, sentAt: NOW - DAY, text: "Lunch?" }),
      m({ pk: 2, sentAt: NOW - DAY, chat: code, senderJid: code.jid, senderName: code.name, text: "Your code is 1234" }),
    ];
    const unread = new Map([[ada.jid, 0], [code.jid, 1]]);
    const source = { ...fake(rows), unreadCounts: () => unread };
    const account = connectWhatsappAccount(db, source, () => NOW);
    await syncWhatsappAccount(db, testConfig(), source, account, { backfillDays: 30, blocklist: new Set<string>(), clock: () => NOW });
    const opened = () => db.select().from(threadOpens).all().map((o) => o.threadId).sort();
    expect(opened()).toEqual([`${account.id}:${ada.jid}`]);
    unread.set(code.jid, 0);
    await syncWhatsappAccount(db, testConfig(), { ...fake(rows), unreadCounts: () => unread }, account, { backfillDays: 30, blocklist: new Set<string>(), clock: () => NOW + 1000 });
    expect(opened()).toEqual([`${account.id}:${code.jid}`, `${account.id}:${ada.jid}`].sort());
  });
});
