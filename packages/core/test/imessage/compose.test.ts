import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testConfig, testDb } from "../helpers/db";
import { drafts, messages, threads } from "../../src/db/schema";
import { connectImessageAccount } from "../../src/imessage/account";
import { syncImessageAccount } from "../../src/imessage/sync";
import { OPERATOR_MODEL, sendText } from "../../src/imessage/compose";
import type { ImessageSource, TextRow } from "../../src/imessage/types";
import type { Sender } from "../../src/connectors/types";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);

function text(p: Partial<TextRow> & Pick<TextRow, "rowid" | "guid" | "sentAt">): TextRow {
  return { chatGuid: "iMessage;-;+14155550100", handle: "+14155550100", service: "iMessage", text: `text ${p.rowid}`, isFromMe: false, attachments: [], ...p };
}

function fakeSource(rows: TextRow[]): ImessageSource {
  return {
    ownHandle: () => "me@example.com",
    textsAfter: (after, since, limit) => rows.filter((r) => r.rowid > after && (since === null || r.sentAt > since)).slice(0, limit),
    latestOwnText: () => null,
    contactNames: () => new Map(),
    close() {},
  };
}

async function chat(rows: TextRow[]) {
  const db = testDb();
  const source = fakeSource(rows);
  const account = connectImessageAccount(db, source, () => NOW);
  await syncImessageAccount(db, testConfig(), source, account, { backfillDays: 7, blocklist: new Set<string>(), clock: () => NOW });
  const thread = db.select().from(threads).get()!;
  return { db, thread };
}

describe("sendText", () => {
  it("texts the person the chat is with, through a draft of the operator's own", async () => {
    const { db, thread } = await chat([text({ rowid: 1, guid: "g1", sentAt: NOW - DAY, text: "Lunch?" })]);
    const sent: { to: string[]; body: string }[] = [];
    const sender: Sender = { sendReply: async (p) => (sent.push({ to: p.to, body: p.body }), { id: "sent-1" }) };
    const r = await sendText(db, sender, { threadId: thread.id, text: "  Noon works  " }, () => NOW);
    expect(sent).toEqual([{ to: ["+14155550100"], body: "Noon works" }]);
    const d = db.select().from(drafts).where(eq(drafts.id, r.draftId)).get()!;
    expect(d.status).toBe("sent");
    expect(d.model).toBe(OPERATOR_MODEL);
    expect(d.sentProviderMessageId).toBe("sent-1");
  });

  it("still knows who the chat is with when the operator wrote last", async () => {
    const { db, thread } = await chat([
      text({ rowid: 1, guid: "g1", sentAt: NOW - DAY, text: "Lunch?" }),
      text({ rowid: 2, guid: "g2", sentAt: NOW - DAY + 1000, text: "Sure", isFromMe: true }),
    ]);
    const to: string[][] = [];
    const sender: Sender = { sendReply: async (p) => (to.push(p.to), { id: "sent-2" }) };
    await sendText(db, sender, { threadId: thread.id, text: "Where?" }, () => NOW);
    expect(to).toEqual([["+14155550100"]]);
    expect(db.select().from(messages).all().length).toBe(2);
  });

  it("refuses an empty text and a thread that is not a chat", async () => {
    const { db, thread } = await chat([text({ rowid: 1, guid: "g1", sentAt: NOW - DAY })]);
    const sender: Sender = { sendReply: async () => ({ id: "x" }) };
    await expect(sendText(db, sender, { threadId: thread.id, text: "  " })).rejects.toThrow(/empty/);
    await expect(sendText(db, sender, { threadId: "nope", text: "hi" })).rejects.toThrow(/not found/);
  });
});
