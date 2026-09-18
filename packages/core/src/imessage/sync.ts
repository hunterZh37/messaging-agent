import { and, eq } from "drizzle-orm";
import type { Config } from "../config";
import { noteBackfilledSince } from "../connectors/backfill";
import { storeNormalizedMessage } from "../connectors/store";
import type { BackfillOptions, SyncOptions, SyncResult } from "../connectors/types";
import { now, type Db } from "../db/client";
import { contacts, messages, watermarks, type AccountRow } from "../db/schema";
import { normalizeHandle } from "./contacts";
import { contactNameFor, renameChatThreads } from "../connectors/names";
import { markMessagesReadElsewhere } from "../queue/inbox";
import { messageRowId } from "../connectors/store";
import { normalizeText } from "./normalize";
import type { ImessageSource } from "./types";

/** How far back the first sync reaches (operator, 2026-09-11: 30 days, then live). */
export const TEXTS_BACKFILL_DAYS = 30;
/** How far back a sync asks Messages what was read since. */
const READ_REFRESH_MS = 7 * 86_400_000;
const PAGE = 500;

interface TextsWatermark {
  rowid: number;
}

function parseWatermark(raw: string | undefined): TextsWatermark | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<TextsWatermark>;
    return typeof v.rowid === "number" ? { rowid: v.rowid } : null;
  } catch {
    return null;
  }
}

/** Names from the address book, kept in our own table so a row is drawn without touching the address book. */
export function refreshContacts(db: Db, names: Map<string, string>, clock: () => number = now): number {
  const at = clock();
  let n = 0;
  db.transaction((tx) => {
    for (const [handle, name] of names) {
      tx.insert(contacts).values({ handle, name, refreshedAt: at }).onConflictDoUpdate({ target: contacts.handle, set: { name, refreshedAt: at } }).run();
      n++;
    }
  });
  return n;
}

/** The name we hold for a handle, or null. */
export function contactName(db: Db, handle: string): string | null {
  return db.select({ name: contacts.name }).from(contacts).where(eq(contacts.handle, normalizeHandle(handle))).get()?.name ?? null;
}

/**
 * Reads what is new in chat.db since the last sync (2026-09-11). The
 * watermark is the highest message ROWID stored; the first run reaches 30
 * days back. Every text goes through the same store as mail, so threads,
 * counts, search and the sorter see it without a second path.
 */
export async function syncImessageAccount(db: Db, cfg: Config, source: ImessageSource, account: AccountRow, opts: SyncOptions): Promise<SyncResult> {
  const clock = opts.clock ?? now;
  const at = clock();
  const wm = parseWatermark(db.select().from(watermarks).where(eq(watermarks.accountId, account.id)).get()?.historyId);
  const first = wm === null;
  const since = first ? (opts.backfillTo === null ? null : (opts.backfillTo ?? at - TEXTS_BACKFILL_DAYS * 86_400_000)) : null;
  const ownHandle = source.ownHandle() ?? account.email.replace(/^messages:/, "");
  const names = source.contactNames();
  refreshContacts(db, names, clock);
  // A contact added since a chat was stored names it now (2026-09-14).
  renameChatThreads(db, account.id, (chat) => contactNameFor(names, chat.handle));

  let fetched = 0;
  let stored = 0;
  let failed = 0;
  let highest = wm?.rowid ?? 0;
  for (;;) {
    const page = source.textsAfter(highest, since, PAGE);
    if (page.length === 0) break;
    for (const t of page) {
      fetched++;
      highest = Math.max(highest, t.rowid);
      // A bubble with nothing to read (a tapback, a sticker) is skipped; the
      // watermark still moves past it.
      if (!t.text && t.attachments.length === 0) continue;
      try {
        if (await storeNormalizedMessage(db, cfg, account, normalizeText(t, ownHandle, names), at)) stored++;
      } catch (err) {
        failed++;
        console.error(`imessage sync: could not store ${t.guid}: ${(err as Error).message}`);
      }
    }
    if (page.length < PAGE) break;
  }

  const historyId = JSON.stringify({ rowid: highest } satisfies TextsWatermark);
  // Texts read on the phone since the last sync open their chats here too
  // (operator, 2026-09-14): a week of is_read, by guid.
  const readGuids = source.readGuidsSince?.(at - READ_REFRESH_MS) ?? [];
  if (readGuids.length > 0) markMessagesReadElsewhere(db, readGuids.map((g) => messageRowId(account.id, g)));

  db.insert(watermarks)
    .values({ accountId: account.id, historyId, lastSyncAt: at })
    .onConflictDoUpdate({ target: watermarks.accountId, set: { historyId, lastSyncAt: at } })
    .run();
  if (first) noteBackfilledSince(db, account, since);
  return { mode: first ? "backfill" : "history", fetched, stored, blocked: 0, failed };
}

/**
 * Reaches back past what the first sync took (operator, 2026-09-11: all
 * history, so a password a colleague sent in May is there to be asked
 * for). Every text older than the watermark is read again from the start;
 * the store skips what it already holds, so this is one pass over
 * chat.db and nothing more. `opts.to` null means the whole history.
 */
/**
 * Whether this chat was deleted or hidden in Celeste: it has rows in Trash
 * here and none live. A backfill files its older texts in Trash too.
 */
const deletedHereCache = new Map<string, boolean>();
export function deletedHere(db: Db, accountId: string, chatId: string): boolean {
  const threadId = `${accountId}:${chatId}`;
  const cached = deletedHereCache.get(threadId);
  if (cached !== undefined) return cached;
  const trashed = db.select({ id: messages.id }).from(messages).where(and(eq(messages.threadId, threadId), eq(messages.folder, "trash"))).get();
  const live = trashed ? db.select({ id: messages.id }).from(messages).where(and(eq(messages.threadId, threadId), eq(messages.folder, "messages"))).get() : null;
  const v = Boolean(trashed) && !live;
  deletedHereCache.set(threadId, v);
  return v;
}

export async function backfillImessageAccount(db: Db, cfg: Config, source: ImessageSource, account: AccountRow, opts: BackfillOptions): Promise<SyncResult & { mode: "backfill" }> {
  const clock = opts.clock ?? now;
  const at = clock();
  deletedHereCache.clear();
  const wm = parseWatermark(db.select().from(watermarks).where(eq(watermarks.accountId, account.id)).get()?.historyId);
  const ownHandle = source.ownHandle() ?? account.email.replace(/^messages:/, "");
  const names = source.contactNames();
  let fetched = 0;
  let stored = 0;
  let failed = 0;
  let cursor = 0;
  for (;;) {
    const page = source.textsAfter(cursor, opts.to, PAGE);
    if (page.length === 0) break;
    for (const t of page) {
      if (wm && t.rowid > wm.rowid) break;
      fetched++;
      cursor = Math.max(cursor, t.rowid);
      // Already here: a read, not a write the store would refuse anyway
      // (stress loop, 2026-09-11: a rerun took the write lock once per row).
      if (db.select({ id: messages.id }).from(messages).where(eq(messages.id, `${account.id}:${t.guid}`)).get()) continue;
      if (!t.text && t.attachments.length === 0) continue;
      try {
        // A chat deleted or hidden here stays that way: its older texts
        // land in Trash with the rest (2026-09-13: a backfill after a
        // Delete all brought twelve deleted chats back with old history).
        const n = normalizeText(t, ownHandle, names);
        if (deletedHere(db, account.id, t.chatGuid)) n.folder = "trash";
        if (await storeNormalizedMessage(db, cfg, account, n, at)) stored++;
      } catch (err) {
        failed++;
        console.error(`imessage backfill: could not store ${t.guid}: ${(err as Error).message}`);
      }
    }
    // A breath between pages, so the app's own writes (a hide, a delete) get
    // the lock in between (stress loop, 2026-09-11: "database is locked").
    await new Promise((r) => setTimeout(r, 40));
    const last = page[page.length - 1]!;
    if (page.length < PAGE || (wm && last.rowid >= wm.rowid)) break;
    cursor = Math.max(cursor, last.rowid);
  }
  noteBackfilledSince(db, account, opts.to);
  return { mode: "backfill", fetched, stored, blocked: 0, failed };
}
