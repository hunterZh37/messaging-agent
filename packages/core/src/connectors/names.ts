import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { messages, threads } from "../db/schema";
import { indexMessageForSearch } from "../chat/search";
import { normalizeHandle } from "../imessage/contacts";

/**
 * A chat called by a number rather than a name (operator, 2026-09-14: "the
 * contact names are not synced"): "+1 (650) 862‑8157", "14155238886",
 * "60754". Formatting and the invisible marks WhatsApp wraps a number in
 * are ignored; five digits and nothing but digits and punctuation is a
 * number.
 */
export function isNumberish(name: string): boolean {
  const bare = name.replace(/[\s‪‬‎‑()+.\-]/g, "");
  return bare.length >= 5 && /^\d+$/.test(bare);
}

/** The name the Mac's Contacts holds for a number or address, or null. */
export function contactNameFor(contacts: Map<string, string>, handle: string | null | undefined): string | null {
  if (!handle) return null;
  const key = normalizeHandle(handle);
  return key ? (contacts.get(key) ?? null) : null;
}

/**
 * What a chat should be called, given the name the app shows and what
 * Contacts knows: the app's name when it is a name, else Contacts by the
 * chat's number, else the app's name as it is. WhatsApp names an unsaved
 * contact by their number; Contacts on this Mac may know them anyway.
 */
export function chatNameFrom(appName: string, phone: string | null | undefined, contacts: Map<string, string>): string {
  if (!isNumberish(appName)) return appName;
  return contactNameFor(contacts, phone ? `+${phone.replace(/\D/g, "")}` : null) ?? contactNameFor(contacts, `+${appName.replace(/\D/g, "")}`) ?? appName;
}

export interface ChatToName {
  id: string;
  providerThreadId: string;
  subject: string;
  /** The other party's handle, read off the chat's own texts: theirs from, or ours to. */
  handle: string | null;
}

/**
 * Renames the chats of one account whose name has changed since they were
 * stored (2026-09-14): a chat was named when its first text landed, and a
 * contact added afterwards left it called by the number forever. `resolve`
 * says what each chat is called now, or null to leave it; a new name goes
 * on the thread, on every text in it, on the sender of every inbound text,
 * and into the search index. Returns how many chats changed.
 */
export function renameChatThreads(db: Db, accountId: string, resolve: (chat: ChatToName) => string | null): number {
  const rows = db.select({ id: threads.id, providerThreadId: threads.providerThreadId, subject: threads.subject }).from(threads).where(eq(threads.accountId, accountId)).all();
  let renamed = 0;
  for (const t of rows) {
    const theirs = db
      .select({ from: messages.fromAddress, to: messages.toAddresses, mine: messages.isFromOperator })
      .from(messages)
      .where(eq(messages.threadId, t.id))
      .limit(50)
      .all();
    const handle = theirs.find((m) => !m.mine)?.from ?? theirs.find((m) => m.mine)?.to[0] ?? null;
    const name = resolve({ id: t.id, providerThreadId: t.providerThreadId, subject: t.subject, handle });
    if (!name || name === t.subject) continue;
    db.transaction((tx) => {
      tx.update(threads).set({ subject: name }).where(eq(threads.id, t.id)).run();
      tx.update(messages).set({ subject: name }).where(eq(messages.threadId, t.id)).run();
      tx.update(messages).set({ fromName: name }).where(and(eq(messages.threadId, t.id), eq(messages.isFromOperator, false))).run();
    });
    for (const m of db.select().from(messages).where(eq(messages.threadId, t.id)).all()) indexMessageForSearch(db, m);
    renamed++;
  }
  return renamed;
}
