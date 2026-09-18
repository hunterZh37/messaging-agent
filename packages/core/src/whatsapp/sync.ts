import { and, eq } from "drizzle-orm";
import type { Config } from "../config";
import { noteBackfilledSince } from "../connectors/backfill";
import { storeNormalizedMessage } from "../connectors/store";
import { chatNameFrom, renameChatThreads } from "../connectors/names";
import { markThreadOpenedUpTo } from "../queue/inbox";
import { threads } from "../db/schema";
import { readAddressBook } from "../imessage/contacts";
import type { BackfillOptions, SyncOptions, SyncResult } from "../connectors/types";
import { now, type Db } from "../db/client";
import { messages, watermarks, type AccountRow } from "../db/schema";
import { normalizeWhatsapp, type WaSelf } from "./normalize";
import type { WhatsappSource } from "./types";

export const WHATSAPP_BACKFILL_DAYS = 30;
const PAGE = 500;

interface WaWatermark {
  pk: number;
}

function parseWatermark(raw: string | undefined): WaWatermark | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<WaWatermark>;
    return typeof v.pk === "number" ? { pk: v.pk } : null;
  } catch {
    return null;
  }
}

/** Who the operator is, from the store or, failing that, from the account's own key. */
export function selfOf(source: WhatsappSource, account: AccountRow): WaSelf {
  const own = source.own();
  if (own) return own;
  const phone = account.email.replace(/^whatsapp:/, "");
  return { jid: `${phone}@s.whatsapp.net`, lid: null, phone };
}

/**
 * Chats from ChatStorage into the messages folder (spec 10g): the first run
 * reaches 30 days back, later runs take what is past the stored row id.
 * Media-only rows without a file are skipped; a caption or a file comes
 * through; group events never do (the store leaves them out).
 */
export async function syncWhatsappAccount(db: Db, cfg: Config, source: WhatsappSource, account: AccountRow, opts: SyncOptions): Promise<SyncResult> {
  const clock = opts.clock ?? now;
  const at = clock();
  const wm = parseWatermark(db.select().from(watermarks).where(eq(watermarks.accountId, account.id)).get()?.historyId);
  const first = wm === null;
  const since = first ? (opts.backfillTo === null ? null : (opts.backfillTo ?? at - WHATSAPP_BACKFILL_DAYS * 86_400_000)) : null;
  const self = selfOf(source, account);
  const names = source.pushNames();
  // Contacts on this Mac name what WhatsApp only knows by number (2026-09-14).
  const contacts = source.contactNames?.() ?? readAddressBook();
  // What WhatsApp counts as read is read here (operator, 2026-09-14): a
  // chat with no unread texts is opened up to its newest one.
  const unread = source.unreadCounts?.();
  const readChats = unread ? new Set([...unread].filter(([, n]) => n === 0).map(([jid]) => jid)) : undefined;
  if (readChats) {
    for (const t of db.select({ id: threads.id, providerThreadId: threads.providerThreadId, lastMessageAt: threads.lastMessageAt }).from(threads).where(eq(threads.accountId, account.id)).all()) {
      if (readChats.has(t.providerThreadId)) markThreadOpenedUpTo(db, t.id, t.lastMessageAt);
    }
  }
  renameChatThreads(db, account.id, (chat) => {
    if (chat.providerThreadId.endsWith("@g.us")) return null;
    const current = source.chat(chat.providerThreadId);
    return current ? chatNameFrom(current.name, current.phone, contacts) : chatNameFrom(chat.subject, null, contacts);
  });

  let fetched = 0;
  let stored = 0;
  let failed = 0;
  let highest = wm?.pk ?? 0;
  for (;;) {
    const page = source.messagesAfter(highest, since, PAGE);
    if (page.length === 0) break;
    for (const m of page) {
      fetched++;
      highest = Math.max(highest, m.pk);
      if (!m.text && !m.media) continue;
      try {
        if (await storeNormalizedMessage(db, cfg, account, normalizeWhatsapp(m, self, names, contacts, readChats), at)) stored++;
      } catch (err) {
        failed++;
        console.error(`whatsapp sync: could not store ${m.stanzaId}: ${(err as Error).message}`);
      }
    }
    if (page.length < PAGE) break;
  }

  const historyId = JSON.stringify({ pk: highest } satisfies WaWatermark);
  db.insert(watermarks)
    .values({ accountId: account.id, historyId, lastSyncAt: at })
    .onConflictDoUpdate({ target: watermarks.accountId, set: { historyId, lastSyncAt: at } })
    .run();
  if (first) noteBackfilledSince(db, account, since);
  return { mode: first ? "backfill" : "history", fetched, stored, blocked: 0, failed };
}

/** The same reach back for WhatsApp (operator, 2026-09-11: all history): one pass over ChatStorage up to the watermark, the store skipping what it holds. */
/**
 * Whether this chat was deleted or hidden in Celeste: it has rows in Trash
 * here and none live. A backfill files its older texts in Trash too.
 */
const deletedHereCache = new Map<string, boolean>();
function deletedHere(db: Db, accountId: string, chatId: string): boolean {
  const threadId = `${accountId}:${chatId}`;
  const cached = deletedHereCache.get(threadId);
  if (cached !== undefined) return cached;
  const trashed = db.select({ id: messages.id }).from(messages).where(and(eq(messages.threadId, threadId), eq(messages.folder, "trash"))).get();
  const live = trashed ? db.select({ id: messages.id }).from(messages).where(and(eq(messages.threadId, threadId), eq(messages.folder, "messages"))).get() : null;
  const v = Boolean(trashed) && !live;
  deletedHereCache.set(threadId, v);
  return v;
}

export async function backfillWhatsappAccount(db: Db, cfg: Config, source: WhatsappSource, account: AccountRow, opts: BackfillOptions): Promise<SyncResult & { mode: "backfill" }> {
  const clock = opts.clock ?? now;
  const at = clock();
  deletedHereCache.clear();
  const wm = parseWatermark(db.select().from(watermarks).where(eq(watermarks.accountId, account.id)).get()?.historyId);
  const self = selfOf(source, account);
  const names = source.pushNames();
  const contacts = source.contactNames?.() ?? readAddressBook();
  let fetched = 0;
  let stored = 0;
  let failed = 0;
  let cursor = 0;
  for (;;) {
    const page = source.messagesAfter(cursor, opts.to, PAGE);
    if (page.length === 0) break;
    for (const m of page) {
      if (wm && m.pk > wm.pk) break;
      fetched++;
      cursor = Math.max(cursor, m.pk);
      // Already here: a read, not a write the store would refuse anyway
      // (stress loop, 2026-09-11: a rerun took the write lock once per row).
      if (db.select({ id: messages.id }).from(messages).where(eq(messages.id, `${account.id}:${m.stanzaId}`)).get()) continue;
      if (!m.text && !m.media) continue;
      try {
        // A chat deleted or hidden here stays that way: its older texts
        // land in Trash with the rest (2026-09-13: a backfill after a
        // Delete all brought twelve deleted chats back with old history).
        const n = normalizeWhatsapp(m, self, names, contacts);
        if (deletedHere(db, account.id, m.chat.jid)) n.folder = "trash";
        if (await storeNormalizedMessage(db, cfg, account, n, at)) stored++;
      } catch (err) {
        failed++;
        console.error(`whatsapp backfill: could not store ${m.stanzaId}: ${(err as Error).message}`);
      }
    }
    // A breath between pages, so the app's own writes (a hide, a delete) get
    // the lock in between (stress loop, 2026-09-11: "database is locked").
    await new Promise((r) => setTimeout(r, 40));
    const last = page[page.length - 1]!;
    if (page.length < PAGE || (wm && last.pk >= wm.pk)) break;
    cursor = Math.max(cursor, last.pk);
  }
  noteBackfilledSince(db, account, opts.to);
  return { mode: "backfill", fetched, stored, blocked: 0, failed };
}
