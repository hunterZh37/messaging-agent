import { alias } from "drizzle-orm/sqlite-core";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { now as nowMs, type Db } from "../db/client";
import { asksSomething, stripQuoted } from "../text/quoted";
import type { Finance } from "../sort/types";
import { listPendingDrafts } from "./drafts";
import { GROUP_PREFIX } from "../projects/projects";
import {
  accounts,
  actions,
  attachments,
  drafts,
  messages,
  projectAssignments,
  projects,
  sorts,
  threadOpens,
  threads,
  type AccountRow,
  type AttachmentRow,
  type DraftRow,
  type MailFolder,
  type MessageRow,
  type ProjectRow,
  type SortRow,
  type ThreadRow,
} from "../db/schema";

export interface InboxRow {
  message: MessageRow;
  account: AccountRow;
  sort: SortRow | null;
  thread: ThreadRow;
  /** The project this message is filed under, null when Unfiled (spec 10d). */
  project: ProjectRow | null;
  /** True once a `handled` action has been recorded for this message. */
  handled: boolean;
  /**
   * Something inbound has arrived in this thread since the operator last
   * opened it, or they never have (spec 10a). Read on the row that stands
   * for the thread, which is the newest message in it.
   */
  unread: boolean;
}

/** Shared alias: a message is "handled" when a row of this kind exists for it. */
export const handledActions = alias(actions, "handled_actions");

/**
 * The child rows under Inbox and Sent in the folder tree (spec 10a).
 * `needs_reply` and `no_reply` split the inbox, and `unopened` and
 * `disposable` each cut across them; `waiting` and `not_waiting` split sent
 * mail.
 */
export type FolderStatus =
  /** The four rungs of the ladder (operator, 2026-09-19), in its own order. */
  | "needs_reply"
  | "action"
  | "knowing"
  | "disposable"
  /** Orthogonal to the ladder: read state, the operator's own archiving, and the two sent rows. */
  | "no_reply"
  | "unopened"
  | "waiting"
  | "not_waiting"
  | "hidden";

/** What the waiting heuristic reads off a thread; the dismissal is optional so callers built before it still fit. */
export type WaitingThread = Pick<ThreadRow, "lastFromOperator" | "lastMessageAt"> & { waitingDismissedAt?: number | null };

/**
 * Is this sent message still waiting on an answer? The heuristic behind
 * "Waiting for reply" (spec 10a), no model call: it still ends its thread,
 * and once the quoted history is gone it asks the other side something.
 */
export function isWaitingReply(row: {
  message: Pick<MessageRow, "sentAt" | "bodyText">;
  thread: WaitingThread;
}): boolean {
  // The operator's word beats the heuristic: "No reply needed" on the
  // thread takes it out of Waiting for good, until they put it back.
  if (row.thread.waitingDismissedAt) return false;
  if (!row.thread.lastFromOperator) return false;
  if (row.message.sentAt < row.thread.lastMessageAt) return false;
  return asksSomething(stripQuoted(row.message.bodyText));
}

/** The folder, inbox and window every list and count over a folder shares. */
export interface FolderScope {
  accountId?: string;
  folder?: MailFolder;
  limit?: number;
  before?: number;
  since?: number;
}

/**
 * What "in this folder" means, for every query that counts or lists it: the
 * folder itself, the side it has, and the inbox and window the caller scopes
 * to. Only the two folders the operator lives in have a side: an inbox is
 * what came in, sent is what went out. Trash and Junk hold both. Shared so
 * the project counts describe exactly the list beneath them (spec 10d).
 */
export function folderConditions(opts: FolderScope = {}): SQL[] {
  const folder = opts.folder ?? "inbox";
  const conditions: SQL[] = [eq(messages.folder, folder)];
  if (folder === "inbox") conditions.push(eq(messages.isFromOperator, false));
  if (folder === "sent") conditions.push(eq(messages.isFromOperator, true));
  if (opts.accountId) conditions.push(eq(messages.accountId, opts.accountId));
  if (opts.before !== undefined) conditions.push(lt(messages.sentAt, opts.before));
  if (opts.since !== undefined) conditions.push(gte(messages.sentAt, opts.since));
  return conditions;
}

/**
 * One folder's messages across every account, newest first (spec 10a).
 * `folder` defaults to the inbox, which excludes the operator's own messages
 * so the list reads as an inbox; `sent` is the operator's own mail; Deleted
 * items and Junk hold whatever the provider put there, whoever sent it.
 * `important: true` additionally excludes messages marked handled, since
 * handling a message is how it leaves the Important filter (it stays visible
 * under "All"). `category` narrows to one operator sub-category (spec 7),
 * `Other` included. `finance` narrows to mail the sorter said money moves in,
 * one way or the other (spec 7). `projectId` narrows to one project, or to
 * `"unfiled"` for mail no project claims (spec 10d). `status` is the tree's child row:
 * Need to reply / No need under Inbox, Waiting / Not waiting under Sent.
 * `since` is the window chip's start (spec 5): mail older than it is hidden,
 * and mail with no verdict yet still shows under "All".
 */
/**
 * Has something arrived in this thread since the operator last opened it, or
 * have they never opened it? The one definition of unread, written so it
 * carries its own joins: the counts do not join `thread_opens` and should not
 * have to in order to ask the same question the list asks.
 */
function threadUnread(): SQL {
  // Only mail that reached the inbox, or a text, can make a thread unread
  // again (2026-09-14): a reply that went straight to Junk or Trash used to
  // put the opened thread back in Unopened, showing the mail already read.
  return sql`(
    (select o.opened_at from thread_opens o where o.thread_id = ${messages.threadId}) is null
    or exists (
      select 1 from messages m
      where m.thread_id = ${messages.threadId} and m.is_from_operator = 0
        and m.folder in ('inbox', 'messages')
        and m.sent_at > (select o.opened_at from thread_opens o where o.thread_id = ${messages.threadId})
    )
  )`;
}

/**
 * Is this row the newest message the operator received in its thread? What
 * the inbox shows for a thread, as opposed to what the thread ends with.
 */
function latestInboxInThread(): SQL {
  return sql`${messages.id} = (
    select m.id from messages m
    where m.thread_id = ${messages.threadId} and m.folder = 'inbox' and m.is_from_operator = 0
    order by m.sent_at desc, m.id desc
    limit 1
  )`;
}

/**
 * Is this row the newest message in its thread? Sent mail counts: a thread the
 * operator has answered is not waiting on them, whichever folder the answer
 * sits in. Ties break on id, so exactly one message of a thread ever matches.
 */
/** A WhatsApp group: its thread is keyed by a `@g.us` JID (spec 10g). */
function isGroupChat(): SQL {
  return sql`${threads.providerThreadId} like '%@g.us'`;
}

function latestInThread(): SQL {
  return sql`${messages.id} = (
    select m.id from messages m
    where m.thread_id = ${messages.threadId}
    order by m.sent_at desc, m.id desc
    limit 1
  )`;
}

/** Everything that decides which messages a view holds, beyond the folder itself. */
export interface InboxScope extends FolderScope {
  important?: boolean;
  category?: string;
  finance?: Exclude<Finance, "none">;
  projectId?: string | "unfiled";
  status?: FolderStatus;
  /** The moment the list is read, for the rules that age out; tests set it. */
  now?: number;
}

/** How far before an inbox was connected its mail is live (operator, 2026-09-14): the status rows never reach further back. */
export const LIVE_BEFORE_CONNECT_MS = 30 * 86_400_000;
/** A chat needs a reply for this long after the other person's last word, then it has gone quiet (operator, 2026-09-14). */
export const CHAT_REPLY_WINDOW_MS = 14 * 86_400_000;

/**
 * Only what arrived since the account was live: the 30 days before it was
 * connected, and everything after. History pulled in behind that stays
 * searchable and stays out of Need to reply, Unopened, Safe to delete and
 * Waiting (operator, 2026-09-14: "there shouldn't be 217 need to reply").
 */
function liveOnly(): SQL {
  return sql`${messages.sentAt} >= (select a.created_at from accounts a where a.id = ${messages.accountId}) - ${LIVE_BEFORE_CONNECT_MS}`;
}

/** The digits of a handle, so "+1 (415) 555-0133" and "+14155550133" read as one number. */
function digitsOf(col: SQL): SQL {
  const strip = ["' '", "'-'", "'('", "')'", "'+'", "'.'", "'\u2011'", "'\u202a'", "'\u202c'", "'\u200e'"];
  let out = col;
  for (const ch of strip) out = sql`replace(${out}, ${sql.raw(ch)}, '')`;
  return out;
}

/**
 * A chat with no name: the chat is called by the handle itself (a WhatsApp
 * handle carries its @domain), or by the same number written prettily
 * (2026-09-14: "+91 99999 00000" counted as a name). Verification codes,
 * deliveries, promos, short codes; never a friend.
 */
function noName(): SQL {
  const subjectDigits = digitsOf(sql`${messages.subject}`);
  // `=` rather than LIKE: LIKE ignores case, and "Grace" would have read
  // as the handle grace@icloud.com, a person with no name.
  return sql`(
    ${messages.subject} = ${messages.fromAddress}
    or substr(${messages.fromAddress}, 1, length(${messages.subject}) + 1) = ${messages.subject} || '@'
    or (${subjectDigits} <> '' and ${subjectDigits} glob '[0-9]*' and ${subjectDigits} = ${digitsOf(sql`${messages.fromAddress}`)})
  )`;
}

/**
 * The whole `WHERE` of a view: the folder and its side, the account and
 * window, the operator's filters, and the tree's child row. The list and
 * every count over it are built from this one function, so a number in the
 * header can never describe a different set of messages than the rows
 * underneath it — which is exactly what it used to do when the counts
 * ignored the child row.
 *
 * A query using these must join what they name: `sorts`, `threads`,
 * `handledActions` and `projectAssignments`, the same way and in the same
 * direction `listInboxMessages` does. The Sent folder's Waiting split is not
 * here, because it is a heuristic over the message text rather than SQL;
 * `applyWaiting` is the other half and is shared the same way.
 */
export function scopeConditions(opts: InboxScope = {}): SQL[] {
  const folder = opts.folder ?? "inbox";
  const sorting =
    opts.status === "needs_reply" ||
    opts.status === "action" ||
    opts.status === "knowing" ||
    opts.status === "unopened" ||
    opts.status === "no_reply" ||
    opts.status === "disposable";
  // Every row follows the window, Safe to delete for chats included
  // (operator, 2026-09-13: it had ignored it, and the header said 7 days
  // over a list reaching back to February).
  const conditions = folderConditions(opts);
  // A hidden thread leaves the mailbox, not just the four sorting lists
  // (operator, 2026-09-16: "hide until the sender sends another message" —
  // it had stayed in Inbox wearing a Hidden badge, which read as the hide
  // not working). It waits in the Hidden row until they write again.
  if (folder === "inbox" || folder === "messages") {
    conditions.push(opts.status === "hidden" ? isNotNull(threads.hiddenAt) : isNull(threads.hiddenAt));
    // One row per conversation here, not per message: Hidden answers "what am
    // I not being shown", and a hidden chat of eight hundred texts is one
    // answer, not eight hundred. The newest thing the operator *received* is
    // the row, so a thread they answered last is still listed.
    if (opts.status === "hidden") conditions.push(folder === "inbox" ? latestInboxInThread() : latestInThread());
  }
  if (opts.important) {
    conditions.push(ne(sorts.wants, "bin"));
    conditions.push(isNull(handledActions.id));
  }
  if (opts.category) conditions.push(eq(sorts.category, opts.category));
  // Money is its own axis, so this narrows the whole list rather than only
  // its important half (spec 7). Only the inbox has verdicts to narrow by.
  if (opts.finance) conditions.push(eq(sorts.finance, opts.finance));
  // A message with no assignment row at all is Unfiled too, which the left
  // join says as a null project id either way.
  if (opts.projectId === "unfiled") conditions.push(isNull(projectAssignments.projectId));
  // A group is every project in it (2026-09-15).
  else if (opts.projectId?.startsWith(GROUP_PREFIX)) {
    const groupId = opts.projectId.slice(GROUP_PREFIX.length);
    conditions.push(sql`${projectAssignments.projectId} in (select ${projects.id} from ${projects} where ${projects.groupId} = ${groupId})`);
  } else if (opts.projectId) conditions.push(eq(projectAssignments.projectId, opts.projectId));
  // "Need to reply" is a fact about a thread, not about a message: the thread
  // waits on the operator when the newest thing in it is inbound, the sorter
  // said that message wants an answer, and nobody has handled it. Read per
  // message instead, an exchange answered three replies ago stayed on the
  // list forever, once for every question ever asked in it.
  if (folder === "inbox" && opts.status === "needs_reply") {
    conditions.push(latestInThread(), eq(sorts.wants, "reply"), isNull(handledActions.id), liveOnly());
  }
  // A chat needs a reply when the other person had the last word and nobody
  // has marked it handled: a fact, not a verdict (operator, 2026-09-11: the
  // local sorter called a friend's text "no reply needed" and the chat never
  // reached Need to reply). Texts are not sorted at all.
  // A group (WhatsApp, spec 10g) needs a reply only when its newest message
  // mentions the operator: every group message is someone else's last word.
  // And only from people the operator knows, only while it is recent
  // (operator, 2026-09-14: 217 rows, 200 of them conversations that ended
  // months ago and 51 from short codes): a name in the address book or a
  // chat they have written in, with the last word inside two weeks.
  if (folder === "messages" && opts.status === "needs_reply") {
    conditions.push(
      latestInThread(),
      isNull(handledActions.id),
      liveOnly(),
      gte(messages.sentAt, (opts.now ?? nowMs()) - CHAT_REPLY_WINDOW_MS),
      or(and(sql`not (${isGroupChat()})`, eq(messages.isFromOperator, false)), and(isGroupChat(), eq(messages.mentionsOperator, true)))!,
      sql`(not ${noName()} or exists (select 1 from messages o where o.thread_id = ${messages.threadId} and o.is_from_operator = 1))`,
    );
  }
  // "Unopened" cuts across the other two rather than splitting with them: a
  // thread waiting on an answer can also be one nobody has looked at. It
  // shows the newest message the operator received, which is what the inbox
  // shows for a thread.
  if (folder === "inbox" && opts.status === "unopened") {
    conditions.push(latestInboxInThread(), threadUnread(), liveOnly());
  }
  // Texts (2026-09-11): the same two rows, over the chat's newest text.
  if (folder === "messages" && opts.status === "unopened") {
    conditions.push(latestInThread(), threadUnread(), liveOnly());
  }
  // "Safe to delete" cuts across the other rows as Unopened does: what the
  // sorter says nobody will need again once it has been read (spec 7,
  // 2026-09-11). Only the inbox has such a verdict, and a message with no
  // verdict at all is never offered for deletion.
  //
  // This one row reaches back past the live line (operator, 2026-09-18).
  // `liveOnly` was added on 2026-09-14 to stop back-filled history flooding
  // Need to reply, and it was applied to all four rows at once. On this row
  // flooding is the point: old junk is the best junk to delete, and the rule
  // was hiding 1,448 of this mailbox's 1,678 inbox messages from the one
  // list whose job is to clear them out. Nothing here claims the operator
  // owes anything, which is what the live line exists to prevent.
  // The two middle rungs (operator, 2026-09-19). They read like the two
  // either side of them: the newest inbound message of the thread, nothing
  // the operator has already marked handled, and inside the live line —
  // which "action" keeps because it is a claim on the operator, and the bin
  // does not because clearing out old junk is the point of that row.
  if (folder === "inbox" && opts.status === "action") {
    conditions.push(latestInThread(), eq(sorts.wants, "action"), isNull(handledActions.id), liveOnly());
  }
  if (folder === "inbox" && opts.status === "knowing") {
    conditions.push(latestInThread(), eq(sorts.wants, "knowing"), liveOnly());
  }
  if (folder === "inbox" && opts.status === "disposable") {
    conditions.push(eq(sorts.wants, "bin"));
  }
  // A chat is safe to delete by a rule (operator, 2026-09-11): the handle has
  // no name in the address book (the chat's subject is the handle itself)
  // and the operator never wrote back. Verification codes, deliveries,
  // promos, short codes; never a friend.
  if (folder === "messages" && opts.status === "disposable") {
    conditions.push(
      latestInThread(),
      liveOnly(),
      sql`not (${isGroupChat()})`,
      eq(messages.isFromOperator, false),
      noName(),
      sql`not exists (select 1 from messages o where o.thread_id = ${messages.threadId} and o.is_from_operator = 1)`,
    );
  }
  // Waiting is read off the text (applyWaiting), but only over live mail.
  if (folder === "sent" && (opts.status === "waiting" || opts.status === "not_waiting")) {
    conditions.push(liveOnly());
  }
  // "No need to reply" is everything else in the inbox: unsorted mail, mail
  // the sorter cleared, mail already handled, and every message that is not
  // the last word in its thread.
  if (folder === "inbox" && opts.status === "no_reply") {
    conditions.push(
      or(
        isNull(sorts.messageId),
        ne(sorts.wants, "reply"),
        isNotNull(handledActions.id),
        sql`not (${latestInThread()})`,
      )!,
    );
  }
  return conditions;
}

/**
 * The Sent folder's Waiting / Not waiting split, which reads the message text
 * and so cannot be a condition. Shared by the list and the counts for the
 * same reason `scopeConditions` is. Everything else passes through untouched.
 */
export function applyWaiting<T extends { message: Pick<MessageRow, "sentAt" | "bodyText">; thread: WaitingThread }>(
  rows: T[],
  opts: InboxScope,
): T[] {
  // Only the two statuses that are about waiting; an inbox status asked of
  // Sent narrows nothing, rather than silently meaning "not waiting".
  if ((opts.folder ?? "inbox") !== "sent") return rows;
  if (opts.status !== "waiting" && opts.status !== "not_waiting") return rows;
  const waiting = opts.status === "waiting";
  return rows.filter((r) => isWaitingReply(r) === waiting);
}

export function listInboxMessages(db: Db, opts: InboxScope = {}): InboxRow[] {
  const limit = opts.limit ?? 100;
  const conditions = scopeConditions(opts);

  const rows = db
    .select({
      message: messages,
      account: accounts,
      sort: sorts,
      thread: threads,
      project: projects,
      handledId: handledActions.id,
      unread: sql<number>`${threadUnread()}`,
    })
    .from(messages)
    .innerJoin(accounts, eq(accounts.id, messages.accountId))
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .leftJoin(sorts, eq(sorts.messageId, messages.id))
    .leftJoin(projectAssignments, eq(projectAssignments.messageId, messages.id))
    .leftJoin(projects, eq(projects.id, projectAssignments.projectId))
    .leftJoin(handledActions, and(eq(handledActions.messageId, messages.id), eq(handledActions.kind, "handled")))
    .where(and(...conditions))
    .orderBy(desc(messages.sentAt))
    .limit(limit)
    .all()
    .map((r) => ({
      message: r.message,
      account: r.account,
      sort: r.sort,
      thread: r.thread,
      project: r.project,
      handled: r.handledId !== null,
      unread: r.unread === 1,
    }));

  return applyWaiting(rows, opts);
}

/** What the tree's counts are taken over: the whole view, minus the folder and status each row sets. */
export type TreeScope = Omit<CountScope, "folder" | "status" | "limit" | "before">;

/**
 * The counts the folder tree shows (spec 10a): pending drafts, inbox mail
 * that needs a reply, inbox mail nobody has opened, inbox mail that is safe
 * to delete, and sent mail still waiting on one. They are built from `scopeConditions` and `applyWaiting`,
 * the same two pieces the lists are, and take the whole selection — window, project, money side —
 * so a tree row's number is the length of the list that row opens. Money is a
 * verdict on inbound mail only, so it narrows Need to reply and not Waiting,
 * exactly as the Sent list ignores it. Drafts are the whole approval queue,
 * which has no window and no filters of its own.
 */
export function folderCounts(db: Db, opts: TreeScope = {}): { inbox: number; drafts: number; needsReply: number; action: number; knowing: number; unopened: number; disposable: number; waiting: number; hidden: number; texts: { needsReply: number; unopened: number; disposable: number; hidden: number } } {
  const drafts = listPendingDrafts(db, opts.accountId ? { accountId: opts.accountId } : {}).length;

  // What the Inbox list itself holds (operator, 2026-09-18: "need an inbox
  // number for mails"). The rows beneath it each counted something and the
  // folder over them counted nothing, so the one row that answers "how much
  // is there" was the one row with no answer. Counted the way that list is
  // drawn, message by message rather than thread by thread, so the number
  // over the list is the number of rows in it.
  const inbox =
    db
      .select({ count: sql<number>`count(*)` })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .leftJoin(sorts, eq(sorts.messageId, messages.id))
      .leftJoin(projectAssignments, eq(projectAssignments.messageId, messages.id))
      .leftJoin(handledActions, and(eq(handledActions.messageId, messages.id), eq(handledActions.kind, "handled")))
      .where(and(...scopeConditions({ since: opts.since, accountId: opts.accountId, folder: "inbox", ...(opts.now === undefined ? {} : { now: opts.now }) })))
      .get()?.count ?? 0;

  // Texts (2026-09-11): the two rows under Messages, counted over the chats
  // alone, whatever inbox the switcher holds.
  const textCount = (status: "needs_reply" | "unopened" | "disposable" | "hidden") =>
    db
      .select({ count: sql<number>`count(*)` })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .leftJoin(sorts, eq(sorts.messageId, messages.id))
      .leftJoin(projectAssignments, eq(projectAssignments.messageId, messages.id))
      .leftJoin(handledActions, and(eq(handledActions.messageId, messages.id), eq(handledActions.kind, "handled")))
      .where(and(...scopeConditions({ since: opts.since, folder: "messages", status, ...(opts.now === undefined ? {} : { now: opts.now }) })))
      .get()?.count ?? 0;
  const texts = { needsReply: textCount("needs_reply"), unopened: textCount("unopened"), disposable: textCount("disposable"), hidden: textCount("hidden") };

  const needsReply =
    db
      .select({ count: sql<number>`count(*)` })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .leftJoin(sorts, eq(sorts.messageId, messages.id))
      .leftJoin(projectAssignments, eq(projectAssignments.messageId, messages.id))
      .leftJoin(handledActions, and(eq(handledActions.messageId, messages.id), eq(handledActions.kind, "handled")))
      .where(and(...scopeConditions({ ...opts, folder: "inbox", status: "needs_reply" })))
      .get()?.count ?? 0;

  // The two middle rungs, counted exactly as the two either side of them.
  const rungCount = (status: "action" | "knowing") =>
    db
      .select({ count: sql<number>`count(*)` })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .leftJoin(sorts, eq(sorts.messageId, messages.id))
      .leftJoin(projectAssignments, eq(projectAssignments.messageId, messages.id))
      .leftJoin(handledActions, and(eq(handledActions.messageId, messages.id), eq(handledActions.kind, "handled")))
      .where(and(...scopeConditions({ ...opts, folder: "inbox", status })))
      .get()?.count ?? 0;
  const action = rungCount("action");
  const knowing = rungCount("knowing");

  const unopened =
    db
      .select({ count: sql<number>`count(*)` })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .leftJoin(sorts, eq(sorts.messageId, messages.id))
      .leftJoin(projectAssignments, eq(projectAssignments.messageId, messages.id))
      .leftJoin(handledActions, and(eq(handledActions.messageId, messages.id), eq(handledActions.kind, "handled")))
      .where(and(...scopeConditions({ ...opts, folder: "inbox", status: "unopened" })))
      .get()?.count ?? 0;

  const disposable =
    db
      .select({ count: sql<number>`count(*)` })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .leftJoin(sorts, eq(sorts.messageId, messages.id))
      .leftJoin(projectAssignments, eq(projectAssignments.messageId, messages.id))
      .leftJoin(handledActions, and(eq(handledActions.messageId, messages.id), eq(handledActions.kind, "handled")))
      .where(and(...scopeConditions({ ...opts, folder: "inbox", status: "disposable" })))
      .get()?.count ?? 0;

  // Waiting reads the message text, so the rows come back and are filtered
  // the way the Sent list filters them.
  const sent = { ...opts, finance: undefined, folder: "sent", status: "waiting" } as const;
  const sentRows = db
    .select({
      message: { sentAt: messages.sentAt, bodyText: messages.bodyText },
      thread: { lastFromOperator: threads.lastFromOperator, lastMessageAt: threads.lastMessageAt },
    })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .leftJoin(sorts, eq(sorts.messageId, messages.id))
    .leftJoin(projectAssignments, eq(projectAssignments.messageId, messages.id))
    .leftJoin(handledActions, and(eq(handledActions.messageId, messages.id), eq(handledActions.kind, "handled")))
    .where(and(...scopeConditions(sent)))
    .all();

  // What the Hidden row says: conversations waiting out of sight until the
  // other side writes again (2026-09-16).
  const hidden =
    db
      .select({ count: sql<number>`count(*)` })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .leftJoin(sorts, eq(sorts.messageId, messages.id))
      .leftJoin(projectAssignments, eq(projectAssignments.messageId, messages.id))
      .leftJoin(handledActions, and(eq(handledActions.messageId, messages.id), eq(handledActions.kind, "handled")))
      .where(and(...scopeConditions({ ...opts, folder: "inbox", status: "hidden" })))
      .get()?.count ?? 0;

  return { inbox, drafts, needsReply, action, knowing, unopened, disposable, hidden, waiting: applyWaiting(sentRows, sent).length, texts };
}

/**
 * How many important, unhandled messages sit under each sub-category, for
 * the chip counts on `/inbox`. Same population as
 * `listInboxMessages({ important: true })`, including its window, so the
 * counts match the list; categories no message uses are simply absent.
 */
export function countByCategory(db: Db, opts: { accountId?: string; since?: number } = {}): Record<string, number> {
  const conditions = [
    eq(messages.isFromOperator, false),
    ne(sorts.wants, "bin"),
    isNotNull(sorts.category),
    isNull(handledActions.id),
  ];
  if (opts.accountId) conditions.push(eq(messages.accountId, opts.accountId));
  if (opts.since !== undefined) conditions.push(gte(messages.sentAt, opts.since));

  const rows = db
    .select({ category: sorts.category, count: sql<number>`count(*)` })
    .from(messages)
    .innerJoin(sorts, eq(sorts.messageId, messages.id))
    .leftJoin(handledActions, and(eq(handledActions.messageId, messages.id), eq(handledActions.kind, "handled")))
    .where(and(...conditions))
    .groupBy(sorts.category)
    .all();

  const out: Record<string, number> = {};
  for (const r of rows) if (r.category) out[r.category] = r.count;
  return out;
}

/**
 * What a count is taken over: the whole view, including the other filters
 * that are on, so a tab's number is what clicking it would show. Each count
 * drops the one dimension it groups by, so passing the full scope is safe.
 */
export type CountScope = FolderScope & {
  status?: FolderStatus;
  /** The moment the count is read, for the rules that age out; tests set it. */
  now?: number;
  finance?: Exclude<Finance, "none">;
  projectId?: string | "unfiled";
};

/**
 * How much of the inbox is money, each way, for the Finance filter's counts
 * (spec 7). Built from `scopeConditions`, so the window, the tree's child row
 * and the project that is on all narrow it exactly as they narrow the list
 * beneath: each number is what clicking that side would show. Unsorted mail
 * has no money verdict and is in neither side, which is why the join is
 * inner.
 */
export function countByFinance(db: Db, opts: CountScope = {}): { income: number; expense: number } {
  const rows = db
    .select({ finance: sorts.finance, count: sql<number>`count(*)` })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .innerJoin(sorts, eq(sorts.messageId, messages.id))
    .leftJoin(projectAssignments, eq(projectAssignments.messageId, messages.id))
    .leftJoin(handledActions, and(eq(handledActions.messageId, messages.id), eq(handledActions.kind, "handled")))
    // Grouping by the money axis, so the money filter is the one thing left out.
    .where(and(...scopeConditions({ ...opts, folder: "inbox", finance: undefined })))
    .groupBy(sorts.finance)
    .all();

  const by = new Map(rows.map((r) => [r.finance, r.count]));
  return { income: by.get("income") ?? 0, expense: by.get("expense") ?? 0 };
}

/**
 * How many important, unhandled messages one inbox holds, for the counts on
 * the inbox switcher (spec 10a). Same population as
 * `listInboxMessages({ important: true })`: inbound only, sorted important,
 * no `handled` action, and inside `since` when one is given.
 */
export function countImportantUnhandled(db: Db, opts: { accountId?: string; since?: number } = {}): number {
  const conditions = [eq(messages.isFromOperator, false), ne(sorts.wants, "bin"), isNull(handledActions.id)];
  if (opts.accountId) conditions.push(eq(messages.accountId, opts.accountId));
  if (opts.since !== undefined) conditions.push(gte(messages.sentAt, opts.since));

  return (
    db
      .select({ count: sql<number>`count(*)` })
      .from(messages)
      .innerJoin(sorts, eq(sorts.messageId, messages.id))
      .leftJoin(handledActions, and(eq(handledActions.messageId, messages.id), eq(handledActions.kind, "handled")))
      .where(and(...conditions))
      .get()?.count ?? 0
  );
}

export interface ThreadView {
  thread: ThreadRow;
  account: AccountRow;
  messages: MessageRow[];
  /** Sort of the latest inbound message in the thread, if it has been sorted. */
  sort: SortRow | null;
  /** The pending draft for this thread, if any. */
  draft: DraftRow | null;
  /** The project the thread is filed under, from its latest inbound message. Null when Unfiled. */
  project: ProjectRow | null;
  /** This inbox's projects in the operator's order, for the "Move to project…" picker. */
  projects: ProjectRow[];
  /** Kept attachments per message id, ordered by index. Empty for messages with none. */
  attachments: Record<string, AttachmentRow[]>;
}

/** Full history of one thread, oldest first, for the thread view and the draft flow. */
export function getThread(db: Db, threadId: string): ThreadView | null {
  const thread = db.select().from(threads).where(eq(threads.id, threadId)).get();
  if (!thread) return null;
  const account = db.select().from(accounts).where(eq(accounts.id, thread.accountId)).get();
  if (!account) return null;

  const msgs = db.select().from(messages).where(eq(messages.threadId, threadId)).orderBy(asc(messages.sentAt)).all();
  const latestInbound = [...msgs].reverse().find((m) => !m.isFromOperator) ?? null;
  const sort = latestInbound ? (db.select().from(sorts).where(eq(sorts.messageId, latestInbound.id)).get() ?? null) : null;
  const draft = db.select().from(drafts).where(and(eq(drafts.threadId, threadId), eq(drafts.status, "pending"))).get() ?? null;

  const project = latestInbound
    ? db
        .select({ project: projects })
        .from(projectAssignments)
        .innerJoin(projects, eq(projects.id, projectAssignments.projectId))
        .where(eq(projectAssignments.messageId, latestInbound.id))
        .get()?.project ?? null
    : null;
  const accountProjects = db
    .select()
    .from(projects)
    .where(eq(projects.accountId, thread.accountId))
    .orderBy(asc(projects.position))
    .all();

  const byMessage: Record<string, AttachmentRow[]> = {};
  const ids = msgs.map((m) => m.id);
  if (ids.length > 0) {
    const rows = db.select().from(attachments).where(inArray(attachments.messageId, ids)).orderBy(asc(attachments.index)).all();
    for (const row of rows) (byMessage[row.messageId] ??= []).push(row);
  }

  return { thread, account, messages: msgs, sort, draft, project, projects: accountProjects, attachments: byMessage };
}

/** A thread and when it had last been opened before now; null when never. */
export interface ThreadOpenBefore {
  threadId: string;
  openedAt: number | null;
  /**
   * When the bulk mark wrote it (2026-09-14), so an undo can tell a thread
   * still carrying that mark from one the operator has opened since. Absent
   * on records made before undo knew to look.
   */
  markedAt?: number;
}

/**
 * Every thread the Unopened list would show for this view, without the page
 * limit: what "Mark all opened" acts on. Ids rather than rows, because the
 * caller wants the set, not the mail.
 */
export function unopenedThreadIds(db: Db, opts: CountScope & { folder?: "inbox" | "messages" } = {}): string[] {
  return db
    .select({ threadId: messages.threadId })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .leftJoin(sorts, eq(sorts.messageId, messages.id))
    .leftJoin(projectAssignments, eq(projectAssignments.messageId, messages.id))
    .leftJoin(handledActions, and(eq(handledActions.messageId, messages.id), eq(handledActions.kind, "handled")))
    .where(and(...scopeConditions({ ...opts, folder: opts.folder ?? "inbox", status: "unopened" })))
    .all()
    .map((r) => r.threadId);
}

/**
 * Every thread the Safe-to-delete list would show for this view, without the
 * page limit: what "Delete all" acts on (spec 10a, 2026-09-11). Threads
 * rather than messages, because deleting is a thing done to a conversation:
 * a thread holding two disposable messages is one row on that button and two
 * in the tree's count, which is the honest reading of both.
 */
export function disposableThreadIds(db: Db, opts: CountScope & { folder?: "inbox" | "messages" } = {}): string[] {
  const ids = db
    .select({ threadId: messages.threadId })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .leftJoin(sorts, eq(sorts.messageId, messages.id))
    .leftJoin(projectAssignments, eq(projectAssignments.messageId, messages.id))
    .leftJoin(handledActions, and(eq(handledActions.messageId, messages.id), eq(handledActions.kind, "handled")))
    .where(and(...scopeConditions({ ...opts, folder: opts.folder ?? "inbox", status: "disposable" })))
    .orderBy(desc(messages.sentAt))
    .all()
    .map((r) => r.threadId);
  return [...new Set(ids)];
}

/**
 * Every thread the Hidden list would show for this view, without the page
 * limit: what "Delete all" acts on there (operator, 2026-09-18).
 *
 * Hidden is one row per conversation already, so this is a thread list by
 * nature rather than by a dedupe, but it goes through the same shape as
 * Safe to delete so the button above both lists can be one button.
 */
export function hiddenThreadIds(db: Db, opts: CountScope & { folder?: "inbox" | "messages" } = {}): string[] {
  const ids = db
    .select({ threadId: messages.threadId })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .leftJoin(sorts, eq(sorts.messageId, messages.id))
    .leftJoin(projectAssignments, eq(projectAssignments.messageId, messages.id))
    .leftJoin(handledActions, and(eq(handledActions.messageId, messages.id), eq(handledActions.kind, "handled")))
    .where(and(...scopeConditions({ ...opts, folder: opts.folder ?? "inbox", status: "hidden" })))
    .orderBy(desc(messages.sentAt))
    .all()
    .map((r) => r.threadId);
  return [...new Set(ids)];
}

/**
 * Marks a set of threads opened in one go, and hands back what each of them
 * said before. That return value is the undo: this is a bulk action with no
 * confirmation, so the way back has to be kept rather than reconstructed.
 */
export function markThreadsOpened(db: Db, threadIds: string[], at: number = nowMs()): ThreadOpenBefore[] {
  const ids = [...new Set(threadIds)];
  if (ids.length === 0) return [];

  const existing = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 400) {
    for (const row of db.select().from(threadOpens).where(inArray(threadOpens.threadId, ids.slice(i, i + 400))).all()) {
      existing.set(row.threadId, row.openedAt);
    }
  }

  db.transaction((tx) => {
    for (const threadId of ids) {
      tx.insert(threadOpens)
        .values({ threadId, openedAt: at })
        .onConflictDoUpdate({ target: threadOpens.threadId, set: { openedAt: at } })
        .run();
    }
  });
  return ids.map((threadId) => ({ threadId, openedAt: existing.get(threadId) ?? null, markedAt: at }));
}

/**
 * Undo: puts each thread back where it was, and un-opens the ones that never
 * were. A thread the operator has opened by hand since the bulk mark keeps
 * that open (2026-09-14): its record no longer carries the mark's time, and
 * reading it was their act, not the button's.
 */
export function restoreThreadOpens(db: Db, previous: ThreadOpenBefore[]): void {
  if (previous.length === 0) return;
  db.transaction((tx) => {
    for (const { threadId, openedAt, markedAt } of previous) {
      if (markedAt !== undefined) {
        const current = tx.select({ openedAt: threadOpens.openedAt }).from(threadOpens).where(eq(threadOpens.threadId, threadId)).get()?.openedAt;
        if (current !== markedAt) continue;
      }
      if (openedAt === null) {
        tx.delete(threadOpens).where(eq(threadOpens.threadId, threadId)).run();
      } else {
        tx.insert(threadOpens)
          .values({ threadId, openedAt })
          .onConflictDoUpdate({ target: threadOpens.threadId, set: { openedAt } })
          .run();
      }
    }
  });
}

/**
 * Records that the operator opened a thread (spec 10a). Called when the
 * thread view renders it, which is the only moment anyone can say they have
 * seen it. Idempotent: opening it again just moves the time forward, and the
 * next inbound message makes it unread once more.
 */
export function markThreadOpened(db: Db, threadId: string, at: number = nowMs()): void {
  db.insert(threadOpens)
    .values({ threadId, openedAt: at })
    .onConflictDoUpdate({ target: threadOpens.threadId, set: { openedAt: at } })
    .run();
}

/**
 * The provider says a message was read (2026-09-14): the thread is opened
 * up to that message and no further. Later than the open already recorded
 * it moves forward; earlier, it changes nothing, so a newer unread message
 * in the thread keeps the thread unread.
 */
export function markThreadOpenedUpTo(db: Db, threadId: string, at: number): void {
  db.insert(threadOpens)
    .values({ threadId, openedAt: at })
    .onConflictDoUpdate({ target: threadOpens.threadId, set: { openedAt: sql`max(${threadOpens.openedAt}, ${at})` } })
    .run();
}

/** When each of these threads was last opened, for the ones that ever were. */
export function threadOpensOf(db: Db, threadIds: string[]): Record<string, number> {
  if (threadIds.length === 0) return {};
  const rows = db.select().from(threadOpens).where(inArray(threadOpens.threadId, threadIds)).all();
  return Object.fromEntries(rows.map((r) => [r.threadId, r.openedAt]));
}

/**
 * Messages the provider now reports read, by our ids (2026-09-14): what the
 * operator read on their phone since the last sync. Each one opens its
 * thread up to itself.
 */
export function markMessagesReadElsewhere(db: Db, messageIds: string[]): number {
  if (messageIds.length === 0) return 0;
  let marked = 0;
  for (let i = 0; i < messageIds.length; i += 400) {
    const rows = db
      .select({ threadId: messages.threadId, sentAt: messages.sentAt })
      .from(messages)
      .where(and(inArray(messages.id, messageIds.slice(i, i + 400)), eq(messages.isFromOperator, false)))
      .all();
    for (const r of rows) {
      markThreadOpenedUpTo(db, r.threadId, r.sentAt);
      marked++;
    }
  }
  return marked;
}

/**
 * "No reply needed" on a thread the operator sent last: it leaves Waiting
 * for reply at once and stays out until they say otherwise (spec 10a).
 * `waiting: true` is the way back.
 */
export function setThreadWaiting(db: Db, threadId: string, waiting: boolean, clock: () => number = nowMs): void {
  db.update(threads)
    .set({ waitingDismissedAt: waiting ? null : clock() })
    .where(eq(threads.id, threadId))
    .run();
}

/** Where a thread lands when it is taken out of Safe to delete. */
export type KeepDestination = "inbox" | "needs_reply";

/**
 * Take a thread out of Safe to delete and say where it goes instead
 * (operator, 2026-09-18: "move a mail from Safe to delete").
 *
 * The sorter is not asked again and nothing is re-judged: this is the
 * operator's word, the same way "No reply needed" and the waiting dismissal
 * already beat their heuristics.
 *
 * Every message in the thread loses the verdict, not only the newest. The
 * list is per thread and the verdict is per message, so clearing the newest
 * alone would leave the thread sitting there behind an older receipt.
 *
 * `needs_reply` is two facts rather than one, so it writes both: the newest
 * message gains the verdict, and a "handled" mark on it comes off, because
 * the Need-to-reply list passes over anything carrying one and the rescue
 * would have gone nowhere visible.
 *
 * Returns how many messages were changed, so a caller can tell a thread that
 * was never on the list from one that has just left it.
 */
export function keepThread(db: Db, threadId: string, dest: KeepDestination = "inbox"): number {
  const ids = db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .all()
    .map((r) => r.id);
  if (ids.length === 0) return 0;

  const cleared = db
    .update(sorts)
    .set({ wants: "knowing" })
    .where(and(inArray(sorts.messageId, ids), eq(sorts.wants, "bin")))
    .run().changes;
  if (dest !== "needs_reply") return cleared;

  const latest = db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(desc(messages.sentAt), desc(messages.id))
    .limit(1)
    .get();
  if (!latest) return cleared;
  db.update(sorts).set({ wants: "reply" }).where(eq(sorts.messageId, latest.id)).run();
  db.delete(actions).where(and(eq(actions.messageId, latest.id), eq(actions.kind, "handled"))).run();
  return cleared;
}
