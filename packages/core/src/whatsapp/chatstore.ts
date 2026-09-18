import { homedir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { WaChat, WaMessage, WhatsappSource } from "./types";

/** Core Data keeps seconds since 2001-01-01. */
const APPLE_EPOCH_MS = 978_307_200_000;
export function coreDataToMs(seconds: number | null): number {
  return seconds === null || seconds === undefined ? 0 : Math.round(seconds * 1000 + APPLE_EPOCH_MS);
}
export function msToCoreData(ms: number): number {
  return (ms - APPLE_EPOCH_MS) / 1000;
}

export function whatsappContainer(): string {
  return path.join(homedir(), "Library/Group Containers/group.net.whatsapp.WhatsApp.shared");
}
export function defaultChatStoragePath(): string {
  return path.join(whatsappContainer(), "ChatStorage.sqlite");
}
/** Where a media item's local path resolves on this Mac. */
export function mediaFile(localPath: string): string {
  return path.join(whatsappContainer(), "Message", localPath);
}

const PERSON = 0;
const GROUP = 1;
const GROUP_EVENT = 6;

interface RawMessage {
  pk: number;
  stanza: string | null;
  text: string | null;
  is_from_me: number;
  date: number | null;
  type: number;
  from_jid: string | null;
  chat_jid: string;
  chat_alt_jid: string | null;
  chat_name: string | null;
  session_type: number;
  member_jid: string | null;
  member_name: string | null;
  media_path: string | null;
  media_title: string | null;
  media_size: number | null;
}

interface RawSession {
  chat_jid: string;
  chat_alt_jid: string | null;
  chat_name: string | null;
  session_type: number;
  removed: number | null;
}

const PHONE_JID = /^(\d+)@s\.whatsapp\.net$/;

/** The phone number behind a one-to-one chat: from either of the session's two ids, whichever is the phone one. */
export function phoneOfChat(jid: string, altJid: string | null): string | null {
  for (const j of [jid, altJid]) {
    const m = j ? PHONE_JID.exec(j) : null;
    if (m) return m[1]!;
  }
  return null;
}

function chatOf(r: { chat_jid: string; chat_alt_jid: string | null; chat_name: string | null; session_type: number }): WaChat {
  const kind = r.session_type === GROUP ? "group" : "person";
  return {
    jid: r.chat_jid,
    name: (r.chat_name ?? "").trim() || r.chat_jid.replace(/@.*$/, ""),
    kind,
    phone: kind === "person" ? phoneOfChat(r.chat_jid, r.chat_alt_jid) : null,
  };
}

/**
 * ChatStorage.sqlite opened read-only (spec 10g, 2026-09-11). WhatsApp owns
 * the file; this never writes to it. One-to-one chats are session type 0
 * and groups type 1; status, broadcast and community rows are left out.
 * Group events (type 6: joins, leaves, subject changes) are not messages.
 */
export function openChatStorage(file: string = defaultChatStoragePath()): WhatsappSource {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 2000");

  const messagesStmt = db.prepare(`
    select m.Z_PK as pk, m.ZSTANZAID as stanza, m.ZTEXT as text, m.ZISFROMME as is_from_me, m.ZMESSAGEDATE as date, m.ZMESSAGETYPE as type, m.ZFROMJID as from_jid,
           s.ZCONTACTJID as chat_jid, s.ZCONTACTIDENTIFIER as chat_alt_jid, s.ZPARTNERNAME as chat_name, s.ZSESSIONTYPE as session_type,
           gm.ZMEMBERJID as member_jid, gm.ZCONTACTNAME as member_name,
           mi.ZMEDIALOCALPATH as media_path, mi.ZTITLE as media_title, mi.ZFILESIZE as media_size
    from ZWAMESSAGE m
    join ZWACHATSESSION s on s.Z_PK = m.ZCHATSESSION
    left join ZWAGROUPMEMBER gm on gm.Z_PK = m.ZGROUPMEMBER
    left join ZWAMEDIAITEM mi on mi.Z_PK = m.ZMEDIAITEM
    where s.ZSESSIONTYPE in (${PERSON}, ${GROUP}) and m.Z_PK > ? and m.ZMESSAGEDATE > ? and m.ZMESSAGETYPE != ${GROUP_EVENT}
    order by m.Z_PK asc
    limit ?`);
  const ownStmt = db.prepare(`
    select m.Z_PK as pk, m.ZSTANZAID as stanza, m.ZTEXT as text, m.ZISFROMME as is_from_me, m.ZMESSAGEDATE as date, m.ZMESSAGETYPE as type, m.ZFROMJID as from_jid,
           s.ZCONTACTJID as chat_jid, s.ZCONTACTIDENTIFIER as chat_alt_jid, s.ZPARTNERNAME as chat_name, s.ZSESSIONTYPE as session_type,
           null as member_jid, null as member_name, null as media_path, null as media_title, null as media_size
    from ZWAMESSAGE m join ZWACHATSESSION s on s.Z_PK = m.ZCHATSESSION
    where s.ZCONTACTJID = ? and m.ZISFROMME = 1 and m.ZMESSAGEDATE > ? and m.ZTEXT = ?
    order by m.Z_PK desc limit 1`);
  const sessionStmt = db.prepare(`select ZCONTACTJID as chat_jid, ZCONTACTIDENTIFIER as chat_alt_jid, ZPARTNERNAME as chat_name, ZSESSIONTYPE as session_type, ZREMOVED as removed from ZWACHATSESSION where ZCONTACTJID = ?`);
  const countStmt = db.prepare(`select count(*) as n from ZWAMESSAGE m join ZWACHATSESSION s on s.Z_PK = m.ZCHATSESSION where s.ZCONTACTJID = ?`);
  const pushNamesStmt = db.prepare(`select ZJID as jid, ZPUSHNAME as name from ZWAPROFILEPUSHNAME where ZPUSHNAME is not null`);
  const unreadStmt = db.prepare(`select ZCONTACTJID as jid, coalesce(ZUNREADCOUNT, 0) as n from ZWACHATSESSION where ZSESSIONTYPE in (${PERSON}, ${GROUP})`);
  // The operator is the member present in the most groups (spec 10g): the
  // own number is encrypted in WhatsApp's preferences, this is not.
  const ownStmt2 = db.prepare(`select ZMEMBERJID as jid, count(distinct ZCHATSESSION) as n from ZWAGROUPMEMBER where ZMEMBERJID like '%@s.whatsapp.net' group by ZMEMBERJID order by n desc limit 1`);

  let pushNames: Map<string, string> | null = null;
  const names = () => {
    if (!pushNames) pushNames = new Map((pushNamesStmt.all() as { jid: string; name: string }[]).map((r) => [r.jid, r.name]));
    return pushNames;
  };

  let ownLid: string | null | undefined;
  const lidOf = (phone: string): string | null => {
    if (ownLid !== undefined) return ownLid;
    ownLid = null;
    try {
      const lid = new Database(path.join(path.dirname(file), "LID.sqlite"), { readonly: true, fileMustExist: true });
      try {
        const row = lid.prepare(`select ZIDENTIFIER as id from ZWAZACCOUNT where ZPHONENUMBER = ? limit 1`).get(phone) as { id: string | null } | undefined;
        ownLid = row?.id ?? null;
      } finally {
        lid.close();
      }
    } catch {
      ownLid = null;
    }
    return ownLid;
  };

  const toMessage = (r: RawMessage): WaMessage => {
    const chat = chatOf(r);
    const senderJid = r.is_from_me ? null : (r.member_jid ?? (chat.kind === "person" ? r.chat_jid : r.from_jid));
    const senderName = senderJid ? ((r.member_name ?? "").trim() || names().get(senderJid) || null) : null;
    return {
      pk: r.pk,
      stanzaId: r.stanza ?? `pk-${r.pk}`,
      chat,
      text: r.text,
      isFromMe: r.is_from_me === 1,
      sentAt: coreDataToMs(r.date),
      senderJid,
      senderName: chat.kind === "person" ? chat.name : senderName,
      media: r.media_path
        ? { path: r.media_path, filename: (r.media_title ?? "").trim() || path.basename(r.media_path), size: r.media_size ?? 0 }
        : null,
    };
  };

  return {
    own() {
      const row = ownStmt2.get() as { jid: string; n: number } | undefined;
      if (!row) return null;
      const phone = row.jid.replace(/@.*$/, "");
      return { jid: row.jid, lid: lidOf(phone), phone };
    },
    messagesAfter(afterPk, sinceMs, limit) {
      const since = sinceMs === null ? -1e12 : msToCoreData(sinceMs);
      return (messagesStmt.all(afterPk, since, limit) as RawMessage[]).map(toMessage);
    },
    latestOwnMessage(chatJid, afterMs, text) {
      const r = ownStmt.get(chatJid, msToCoreData(afterMs), text) as RawMessage | undefined;
      return r ? toMessage(r) : null;
    },
    chatState(chatJid) {
      const s = sessionStmt.get(chatJid) as RawSession | undefined;
      if (!s) return { exists: false, removed: true, count: 0 };
      return { exists: true, removed: s.removed === 1, count: (countStmt.get(chatJid) as { n: number }).n };
    },
    pushNames() {
      return names();
    },
    unreadCounts() {
      return new Map((unreadStmt.all() as { jid: string; n: number }[]).map((r) => [r.jid, r.n]));
    },
    chat(chatJid) {
      const s = sessionStmt.get(chatJid) as RawSession | undefined;
      return s ? chatOf(s) : null;
    },
    close() {
      db.close();
    },
  };
}
