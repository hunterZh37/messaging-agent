import { eq } from "drizzle-orm";
import { now as nowMs, type Db } from "../db/client";
import { pushSubscriptions } from "../db/schema";
import { listInboxMessages, type InboxRow } from "../queue/inbox";

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** What one notification says, and where tapping it goes. */
export interface Notice {
  title: string;
  body: string;
  /** The thread's page, with the list it belongs to beside it. */
  url: string;
  /** One notification per thread: a second text in the same chat replaces the first. */
  tag: string;
}

export function saveSubscription(db: Db, sub: PushSubscriptionRecord, userAgent: string | null, clock: () => number = nowMs): void {
  db.insert(pushSubscriptions)
    .values({ endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent, createdAt: clock() })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { p256dh: sub.keys.p256dh, auth: sub.keys.auth, userAgent } })
    .run();
}

export function deleteSubscription(db: Db, endpoint: string): void {
  db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).run();
}

export function listSubscriptions(db: Db): PushSubscriptionRecord[] {
  return db
    .select()
    .from(pushSubscriptions)
    .all()
    .map((r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }));
}

const BODY_MAX = 90;

/**
 * What a new message in Need to reply says on the lock screen: who, and the
 * start of what they wrote (2026-09-14). Short on purpose: a lock screen is
 * read by whoever is holding the phone.
 */
export function noticeFor(row: InboxRow): Notice {
  const chat = row.message.folder === "messages";
  const who = row.message.fromName || row.message.fromAddress;
  const title = chat ? row.thread.subject || who : who;
  const text = (row.message.snippet ?? row.message.bodyText ?? "").replace(/\s+/g, " ").trim();
  const lead = chat ? "" : row.message.subject ? `${row.message.subject}: ` : "";
  const body = `${lead}${text}`;
  const folder = chat ? "messages" : "inbox";
  return {
    title,
    body: body.length > BODY_MAX ? `${body.slice(0, BODY_MAX - 1).trimEnd()}…` : body || (chat ? "Sent a message" : "New mail"),
    url: `/inbox/${encodeURIComponent(row.thread.id)}?folder=${folder}&status=needs_reply`,
    tag: row.thread.id,
  };
}

/**
 * What to tell the phone about (2026-09-14): messages that landed in Need to
 * reply, mail or chats, since the last time anything was said. Need to reply
 * is already the list of what matters (people the operator knows, mail the
 * sorter called important and asking), so a notification never says more
 * than that list does. Newest first, at most `limit`.
 */
export function needsReplySince(db: Db, sinceReceivedAt: number, opts: { now?: number; limit?: number } = {}): InboxRow[] {
  const limit = opts.limit ?? 20;
  const scope = { status: "needs_reply" as const, limit: 200, ...(opts.now === undefined ? {} : { now: opts.now }) };
  const rows = [...listInboxMessages(db, { ...scope, folder: "inbox" }), ...listInboxMessages(db, { ...scope, folder: "messages" })];
  return rows
    .filter((r) => r.message.receivedAt > sinceReceivedAt && !r.message.isFromOperator)
    .sort((a, b) => b.message.receivedAt - a.message.receivedAt)
    .slice(0, limit);
}

/**
 * The notices for a batch: one per thread, and when many land at once, one
 * that says how many, so a sync after a long sleep is a single buzz.
 */
export function noticesFor(rows: InboxRow[], max = 3): Notice[] {
  const seen = new Set<string>();
  const perThread = rows.filter((r) => (seen.has(r.thread.id) ? false : (seen.add(r.thread.id), true)));
  if (perThread.length <= max) return perThread.map(noticeFor);
  return [{ title: "Celeste", body: `${perThread.length} new messages need a reply`, url: "/inbox?status=needs_reply", tag: "celeste-batch" }];
}

