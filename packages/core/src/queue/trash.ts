import { and, asc, eq, inArray, isNotNull, or } from "drizzle-orm";
import type { MailConnector } from "../connectors/types";
import { now as nowMs, type Db } from "../db/client";
import { accounts, actions, messages, threads, type AccountRow, type MailFolder } from "../db/schema";
import { recordAction } from "./actions";

/**
 * Deleting mail from Celeste (spec 10a, 2026-09-11). Operator: mail that is
 * safe to delete should be deletable from here, not only listed. It is a
 * gated write like a send — the button, the confirm and the six seconds all
 * happen in the browser before any of this runs — and it moves mail to the
 * provider's own Trash rather than destroying it, so the way back is the
 * provider's thirty days.
 */

/** What one provider's trash call answers: how many moved, and how many refused. */
export interface TrashResult {
  moved: number;
  failed: number;
  /**
   * Why a mailbox could not be written to, when the answer is something
   * other than "it refused" (operator, 2026-09-19). An expired sign-in is
   * the common one, and it is the operator's to fix, so it has to reach
   * them rather than only the log.
   */
  reasons?: { email: string; message: string }[];
}

/**
 * The mailbox is the truth about a deleted message, and this is the record
 * of it on our side: the row moves to Trash, and one append-only `trash`
 * action per message says the operator asked for it. Called by each
 * provider's trash path once the move has actually happened, never before.
 */
export function markTrashed(db: Db, messageIds: string[], clock: () => number = nowMs): void {
  if (messageIds.length === 0) return;
  const at = clock();
  db.transaction((tx) => {
    for (let i = 0; i < messageIds.length; i += 400) {
      tx.update(messages).set({ folder: "trash" }).where(inArray(messages.id, messageIds.slice(i, i + 400))).run();
    }
    for (const messageId of messageIds) recordAction(tx, { kind: "trash", messageId, payload: {} }, () => at);
  });
}

/**
 * Hide (operator, 2026-09-11): the thread leaves Celeste for Deleted items
 * and stays where it is in the mailbox or the app. The row moves to the
 * trash folder here alone, and a `hide` action remembers the folder it
 * came from, so a restore can put it back there without asking the
 * provider for a move that never happened.
 */
export function markHidden(db: Db, messageIds: string[], clock: () => number = nowMs, opts: { auto?: boolean } = {}): void {
  if (messageIds.length === 0) return;
  const at = clock();
  db.transaction((tx) => {
    const rows = messageIds.length === 0 ? [] : tx.select({ id: messages.id, folder: messages.folder }).from(messages).where(inArray(messages.id, messageIds)).all();
    for (const row of rows) recordAction(tx, { kind: "hide", messageId: row.id, payload: { from: row.folder, ...(opts.auto ? { auto: true } : {}) } }, () => at);
    for (let i = 0; i < messageIds.length; i += 400) {
      tx.update(messages).set({ folder: "trash" }).where(inArray(messages.id, messageIds.slice(i, i + 400))).run();
    }
  });
}


/** Which of these trashed messages were hidden rather than deleted: those whose last trash-or-hide action is a hide, with the folder each came from. */
export function hiddenFrom(db: Db, messageIds: string[]): Map<string, MailFolder> {
  const out = new Map<string, MailFolder>();
  for (let i = 0; i < messageIds.length; i += 400) {
    const rows = db
      .select({ messageId: actions.messageId, kind: actions.kind, payload: actions.payload })
      .from(actions)
      .where(and(inArray(actions.messageId, messageIds.slice(i, i + 400)), inArray(actions.kind, ["trash", "hide"])))
      .orderBy(asc(actions.createdAt), asc(actions.id))
      .all();
    const last = new Map<string, { kind: string; payload: Record<string, unknown> }>();
    for (const r of rows) if (r.messageId) last.set(r.messageId, { kind: r.kind, payload: r.payload as Record<string, unknown> });
    for (const [id, a] of last) {
      if (a.kind !== "hide") continue;
      const from = a.payload.from;
      out.set(id, from === "messages" ? "messages" : "inbox");
    }
  }
  return out;
}

/** Brings hidden messages back to the folder each came from, with a `restore` action apiece. */
export function restoreHidden(db: Db, from: Map<string, MailFolder>, clock: () => number = nowMs): void {
  if (from.size === 0) return;
  const at = clock();
  db.transaction((tx) => {
    for (const [id, folder] of from) {
      tx.update(messages).set({ folder }).where(eq(messages.id, id)).run();
      recordAction(tx, { kind: "restore", messageId: id, payload: {} }, () => at);
    }
  });
}

/**
 * Hides whole threads (operator, 2026-09-15: "the hidden emails still show up
 * in inbox, hide is just when temporarily I don't want to see it under need to
 * reply, unopened, no need to reply, safe to delete"). The thread stays where
 * it is, in the mailbox, the app and Celeste's Inbox or Messages; only the
 * four sorting lists leave it out. Until 2026-09-15 a hide moved the thread
 * to Deleted items, which read as the mail being gone. Local, provider
 * untouched.
 */
export function hideThreads(db: Db, threadIds: string[], clock: () => number = nowMs): TrashResult {
  const ids = [...new Set(threadIds)];
  if (ids.length === 0) return { moved: 0, failed: 0 };
  const at = clock();
  db.transaction((tx) => {
    tx.update(threads).set({ hiddenAt: at }).where(inArray(threads.id, ids)).run();
  });
  return { moved: ids.length, failed: 0 };
}

/** Unhide (2026-09-15): the threads are back on every list they belong to. */
export function unhideThreads(db: Db, threadIds: string[]): number {
  const ids = [...new Set(threadIds)];
  if (ids.length === 0) return 0;
  const hidden = db.select({ id: threads.id }).from(threads).where(and(inArray(threads.id, ids), isNotNull(threads.hiddenAt))).all().map((r) => r.id);
  if (hidden.length > 0) db.update(threads).set({ hiddenAt: null }).where(inArray(threads.id, hidden)).run();
  return hidden.length;
}

/**
 * Threads hidden the old way, moved to Deleted items, brought back to the
 * folder each came from and hidden the new way (2026-09-15). What the app hid
 * by itself, a new message from a sender the operator had deleted, is a delete
 * and stays in Deleted items. Safe to run on every start: once converted, a
 * message's last word is a restore.
 */
export function convertLegacyHides(db: Db, clock: () => number = nowMs): number {
  const rows = db.$client
    .prepare(
      `select m.id id, m.thread_id thread_id, a.payload payload, a.created_at at from messages m
       join actions a on a.id = (select x.id from actions x where x.message_id = m.id and x.kind in ('trash', 'hide', 'restore') order by x.created_at desc, x.id desc limit 1)
       where m.folder = 'trash' and a.kind = 'hide'`,
    )
    .all() as { id: string; thread_id: string; payload: string; at: number }[];
  const legacy = rows.filter((r) => {
    try {
      return JSON.parse(r.payload)?.auto !== true;
    } catch {
      return true;
    }
  });
  if (legacy.length === 0) return 0;
  const from = hiddenFrom(db, legacy.map((r) => r.id));
  restoreHidden(db, from, clock);
  const hiddenAtByThread = new Map<string, number>();
  for (const r of legacy) hiddenAtByThread.set(r.thread_id, Math.max(hiddenAtByThread.get(r.thread_id) ?? 0, r.at));
  db.transaction((tx) => {
    for (const [threadId, at] of hiddenAtByThread) tx.update(threads).set({ hiddenAt: at }).where(eq(threads.id, threadId)).run();
  });
  return legacy.length;
}

/**
 * The mirror of markTrashed (spec 10a, 2026-09-11): the row moves back to
 * Inbox, and one append-only `restore` action per message says the operator
 * pressed Cmd-Z. Called by each provider's restore path once the move has
 * actually happened, never before.
 */
export function markRestored(db: Db, messageIds: string[], clock: () => number = nowMs): void {
  if (messageIds.length === 0) return;
  const at = clock();
  db.transaction((tx) => {
    for (let i = 0; i < messageIds.length; i += 400) {
      tx.update(messages).set({ folder: "inbox" }).where(inArray(messages.id, messageIds.slice(i, i + 400))).run();
    }
    for (const messageId of messageIds) recordAction(tx, { kind: "restore", messageId, payload: {} }, () => at);
  });
}

/**
 * A moved message gets a new provider id: Graph on a folder change, IMAP a
 * new uid in the destination folder (spec 10a, 2026-09-11). `messages.id`
 * never changes, so this is where the row catches up with where the
 * message actually ended up, once a move has actually happened. Shared by
 * trash and restore on both providers, so the two ways back stay in sync.
 * Without this the next sync inserted a second row under the new id and
 * left the old one dead (seen live on an Amazon thread).
 */
export function relocate(db: Db, updates: { id: string; providerMessageId: string }[]): void {
  if (updates.length === 0) return;
  db.transaction((tx) => {
    for (const { id, providerMessageId } of updates) {
      tx.update(messages).set({ providerMessageId }).where(eq(messages.id, id)).run();
    }
  });
}

/**
 * Every inbound message of these threads, by account. Sent mail is left
 * where it is: the operator's own words are not the thing they asked to
 * throw away, and a reply of theirs sitting in Trash would read as a send
 * that failed.
 */
export function inboxMessagesForThreads(db: Db, threadIds: string[]): Map<string, string[]> {
  const ids = [...new Set(threadIds)];
  const byAccount = new Map<string, string[]>();
  for (let i = 0; i < ids.length; i += 400) {
    const rows = db
      .select({ id: messages.id, accountId: messages.accountId })
      .from(messages)
      // A chat is deleted whole, the operator's own texts with it (2026-09-11).
      .where(and(inArray(messages.threadId, ids.slice(i, i + 400)), or(and(eq(messages.folder, "inbox"), eq(messages.isFromOperator, false)), eq(messages.folder, "messages"))))
      .all();
    for (const row of rows) {
      const held = byAccount.get(row.accountId);
      if (held) held.push(row.id);
      else byAccount.set(row.accountId, [row.id]);
    }
  }
  return byAccount;
}

/**
 * Moves whole threads to their providers' Trash, one call per inbox. An
 * account whose provider refuses is counted and left behind rather than
 * throwing: a delete over three inboxes must not lose the two that worked.
 */
export async function trashThreads(
  db: Db,
  connectorFor: (account: AccountRow) => MailConnector,
  threadIds: string[],
): Promise<TrashResult> {
  const byAccount = inboxMessagesForThreads(db, threadIds);
  let moved = 0;
  let failed = 0;
  /** Why a mailbox could not be written to, when that is the reason rather than a refusal. */
  const reasons: { email: string; message: string }[] = [];
  for (const [accountId, messageIds] of byAccount) {
    const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
    if (!account) {
      failed += messageIds.length;
      continue;
    }
    try {
      const r = await connectorFor(account).trash(db, account, messageIds);
      moved += r.moved;
      failed += r.failed;
    } catch (err) {
      failed += messageIds.length;
      // Carried back, not only logged (operator, 2026-09-19: "why can't I
      // delete DocuSeal?"). The mailbox had not refused anything: its Google
      // sign-in had expired, so nothing could be written to it at all. The
      // toast said the provider kept the mail, which sent the operator
      // looking for a fault in the mail rather than in the account.
      reasons.push({ email: account.email, message: (err as Error).message });
      console.error(`trash failed for ${account.email}:`, (err as Error).message);
    }
  }
  return { moved, failed, ...(reasons.length > 0 ? { reasons } : {}) };
}

/**
 * Every inbound message of these threads that is currently sitting in
 * Trash, by account (spec 10a, 2026-09-11): what a Cmd-Z over a thread
 * hands back. The mirror of inboxMessagesForThreads; the operator's own
 * mail is left out for the same reason it never went to Trash in the
 * first place.
 */
export function trashMessagesForThreads(db: Db, threadIds: string[]): Map<string, string[]> {
  const ids = [...new Set(threadIds)];
  const byAccount = new Map<string, string[]>();
  for (let i = 0; i < ids.length; i += 400) {
    // Mail: only what was moved, the inbound rows (sent mail never left Sent).
    // A chat was deleted or hidden whole, the operator's own texts with it
    // (stress loop, 2026-09-11: those stayed in Trash after a Put back).
    const rows = db
      .select({ id: messages.id, accountId: messages.accountId })
      .from(messages)
      .innerJoin(accounts, eq(accounts.id, messages.accountId))
      .where(
        and(
          inArray(messages.threadId, ids.slice(i, i + 400)),
          eq(messages.folder, "trash"),
          or(eq(messages.isFromOperator, false), inArray(accounts.provider, ["imessage", "whatsapp"])),
        ),
      )
      .all();
    for (const row of rows) {
      const held = byAccount.get(row.accountId);
      if (held) held.push(row.id);
      else byAccount.set(row.accountId, [row.id]);
    }
  }
  return byAccount;
}

/**
 * Moves whole threads back out of their providers' Trash, one call per
 * inbox (spec 10a, 2026-09-11): undo delete, the mirror of trashThreads and
 * gated exactly the same way. An account whose provider refuses is counted
 * and left in Trash rather than throwing: an undo over three inboxes must
 * not lose the two that worked.
 */
export async function restoreThreads(
  db: Db,
  connectorFor: (account: AccountRow) => MailConnector,
  threadIds: string[],
): Promise<TrashResult> {
  // Undo of a hide (2026-09-15): nothing moved, the threads are only unhidden.
  let moved = unhideThreads(db, threadIds);
  const byAccount = trashMessagesForThreads(db, threadIds);
  let failed = 0;
  for (const [accountId, allIds] of byAccount) {
    // What was hidden comes back here alone: the provider never moved it.
    const hidden = hiddenFrom(db, allIds);
    restoreHidden(db, hidden);
    moved += hidden.size;
    const messageIds = allIds.filter((id) => !hidden.has(id));
    if (messageIds.length === 0) continue;
    const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
    if (!account) {
      failed += messageIds.length;
      continue;
    }
    try {
      const r = await connectorFor(account).restore(db, account, messageIds);
      moved += r.moved;
      failed += r.failed;
    } catch (err) {
      failed += messageIds.length;
      console.error(`restore failed for ${account.email}:`, (err as Error).message);
    }
  }
  return { moved, failed };
}

/**
 * Folds a second stored copy of one message into the first (2026-09-14): the
 * repair for mail hidden here, deleted in Outlook, and then stored twice, once
 * as the stale hidden row and once as the provider's Trash copy. The first
 * row keeps its id, which everything else points at, and takes the copy's
 * provider id and folder; what pointed at the copy moves over where the
 * first row has none of its own; the copy goes.
 */
export function absorbCopy(db: Db, keepId: string, copyId: string): void {
  const c = db.$client;
  const copy = c.prepare("select provider_message_id pid, folder from messages where id = ?").get(copyId) as { pid: string; folder: string } | undefined;
  if (!copy || keepId === copyId) return;
  const tx = c.transaction(() => {
    const has = (table: string) => (c.prepare(`select 1 from ${table} where message_id = ? limit 1`).get(keepId) ? true : false);
    for (const table of ["attachments", "sorts", "project_assignments"]) {
      if (has(table)) c.prepare(`delete from ${table} where message_id = ?`).run(copyId);
      else c.prepare(`update ${table} set message_id = ? where message_id = ?`).run(keepId, copyId);
    }
    c.prepare("update actions set message_id = ? where message_id = ?").run(keepId, copyId);
    c.prepare("update drafts set reply_to_message_id = ? where reply_to_message_id = ?").run(keepId, copyId);
    c.prepare("update eval_results set message_id = ? where message_id = ?").run(keepId, copyId);
    c.prepare("delete from messages_fts where message_id = ?").run(copyId);
    c.prepare("delete from messages where id = ?").run(copyId);
    c.prepare("update messages set provider_message_id = ?, folder = ? where id = ?").run(copy.pid, copy.folder, keepId);
  });
  tx();
}
