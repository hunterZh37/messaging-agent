import { homedir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { readAddressBook } from "./contacts";
import { decodeAttributedBody } from "./typedstream";
import type { ImessageSource, TextAttachment, TextRow } from "./types";

/** Apple stores dates as nanoseconds since 2001-01-01; epoch milliseconds are what the rest of core keeps. */
const APPLE_EPOCH_MS = 978_307_200_000;
export function appleToMs(nanos: number | bigint | null): number {
  if (nanos === null || nanos === undefined) return 0;
  const n = typeof nanos === "bigint" ? Number(nanos) : nanos;
  // Very old rows kept seconds rather than nanoseconds.
  const ms = n > 1e12 ? n / 1e6 : n * 1000;
  return Math.round(ms + APPLE_EPOCH_MS);
}
export function msToApple(ms: number): number {
  return Math.round((ms - APPLE_EPOCH_MS) * 1e6);
}

export function defaultChatDbPath(): string {
  return path.join(homedir(), "Library/Messages/chat.db");
}

interface RawText {
  rowid: number;
  guid: string;
  chat_guid: string;
  handle: string | null;
  service: string | null;
  chat_service: string | null;
  text: string | null;
  attributedBody: Buffer | null;
  is_from_me: number;
  date: number | bigint;
  cache_has_attachments: number;
  is_read?: number | null;
}

/**
 * chat.db opened read-only (2026-09-11). Messages.app owns the file; this
 * never writes to it, and a query that meets it busy is simply retried on
 * the next tick by the caller. One-to-one chats are `style = 45`; groups
 * (`43`) are out of this phase. Tapbacks and their removals carry an
 * `associated_message_type` in the 2000s and 3000s ("Liked “…”") and are
 * not texts; only `0` is.
 */
export function openChatDb(file: string = defaultChatDbPath()): ImessageSource {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 2000");

  const textsStmt = db.prepare(`
    select m.ROWID as rowid, m.guid as guid, c.guid as chat_guid, h.id as handle, m.service as service, c.service_name as chat_service,
           m.text as text, m.attributedBody as attributedBody, m.is_from_me as is_from_me, m.date as date,
           m.cache_has_attachments as cache_has_attachments, m.is_read as is_read
    from message m
    join chat_message_join cmj on cmj.message_id = m.ROWID
    join chat c on c.ROWID = cmj.chat_id
    left join handle h on h.ROWID = coalesce(nullif(m.handle_id, 0), (select chj.handle_id from chat_handle_join chj where chj.chat_id = c.ROWID limit 1))
    where c.style = 45 and m.ROWID > ? and m.date > ? and m.item_type = 0 and m.associated_message_type = 0
    order by m.ROWID asc
    limit ?`);
  const attStmt = db.prepare(`
    select a.guid as guid, a.filename as filename, a.transfer_name as transfer_name, a.mime_type as mime_type, a.total_bytes as total_bytes
    from attachment a join message_attachment_join maj on maj.attachment_id = a.ROWID
    where maj.message_id = ? order by a.ROWID asc`);
  const ownStmt = db.prepare(`
    select m.ROWID as rowid, m.guid as guid, c.guid as chat_guid, h.id as handle, m.service as service, c.service_name as chat_service,
           m.text as text, m.attributedBody as attributedBody, m.is_from_me as is_from_me, m.date as date, m.cache_has_attachments as cache_has_attachments
    from message m join chat_message_join cmj on cmj.message_id = m.ROWID join chat c on c.ROWID = cmj.chat_id
    left join handle h on h.ROWID = (select chj.handle_id from chat_handle_join chj where chj.chat_id = c.ROWID limit 1)
    where c.guid = ? and m.is_from_me = 1 and m.date > ? order by m.ROWID desc limit 1`);
  const countStmt = db.prepare(`select count(*) as n from chat_message_join j join chat c on c.ROWID = j.chat_id where c.guid = ?`);
  const readStmt = db.prepare(`select m.guid as guid from message m where m.is_from_me = 0 and m.is_read = 1 and m.date > ? and m.item_type = 0 and m.associated_message_type = 0`);
  const displayStmt = db.prepare(`select display_name as name from chat where guid = ?`);
  const accountStmt = db.prepare(`select account as account, count(*) as n from message where is_from_me = 1 and account is not null and account != '' group by account order by n desc limit 1`);

  const attachmentsOf = (rowid: number): TextAttachment[] =>
    (attStmt.all(rowid) as { guid: string; filename: string | null; transfer_name: string | null; mime_type: string | null; total_bytes: number | null }[]).map((a) => ({
      guid: a.guid,
      path: a.filename ? a.filename.replace(/^~/, homedir()) : null,
      filename: a.transfer_name || (a.filename ? path.basename(a.filename) : "attachment"),
      mimeType: a.mime_type || "application/octet-stream",
      size: a.total_bytes ?? 0,
    }));

  const toRow = (r: RawText): TextRow => ({
    rowid: r.rowid,
    guid: r.guid,
    chatGuid: r.chat_guid,
    handle: r.handle ?? "",
    service: r.service || r.chat_service || "iMessage",
    text: (r.text && r.text.replace(/￼/g, "").trim()) || decodeAttributedBody(r.attributedBody),
    isFromMe: r.is_from_me === 1,
    ...(r.is_read === undefined || r.is_read === null ? {} : { isRead: r.is_read === 1 }),
    sentAt: appleToMs(r.date),
    attachments: r.cache_has_attachments ? attachmentsOf(r.rowid) : [],
  });

  return {
    ownHandle() {
      const row = accountStmt.get() as { account: string } | undefined;
      if (!row) return null;
      // Messages writes "E:someone@example.com" or "P:+14155550100".
      return row.account.replace(/^[EP]:/i, "") || null;
    },
    textsAfter(afterRowid, sinceMs, limit) {
      const since = sinceMs === null ? 0 : msToApple(sinceMs);
      return (textsStmt.all(afterRowid, since, limit) as RawText[]).map(toRow);
    },
    latestOwnText(chatGuid, afterMs) {
      const r = ownStmt.get(chatGuid, msToApple(afterMs)) as RawText | undefined;
      return r ? toRow(r) : null;
    },
    chatDisplayName(chatGuid) {
      return (displayStmt.get(chatGuid) as { name: string | null } | undefined)?.name || null;
    },
    chatTextCount(chatGuid) {
      return (countStmt.get(chatGuid) as { n: number }).n;
    },
    contactNames() {
      return readAddressBook();
    },
    readGuidsSince(sinceMs) {
      return (readStmt.all(msToApple(sinceMs)) as { guid: string }[]).map((r) => r.guid);
    },
    close() {
      db.close();
    },
  };
}
