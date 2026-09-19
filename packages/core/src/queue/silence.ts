import { and, eq, gte, sql } from "drizzle-orm";
import { now as nowMs, type Db } from "../db/client";
import { accounts, messages, watermarks } from "../db/schema";

/**
 * An inbox that has gone quiet for longer than it ever normally does
 * (operator, 2026-09-18).
 *
 * Written the day an Outlook account fetched nothing for twenty six hours
 * while reporting perfect health: status ok, no error, watermark updated
 * every minute, twenty eight messages sitting unread at the provider. A
 * sync that stores nothing looks exactly like an inbox nobody wrote to, and
 * the app believed the wrong one of those for a day.
 *
 * Nothing here asks a provider anything. It compares an inbox against its
 * own past: how long has this one been silent, against how long it usually
 * goes between messages. A busy inbox that has said nothing all day is the
 * alarm; a quiet one that gets a letter a fortnight is not, and the same
 * fixed threshold could not tell those apart.
 */

/** Below this many messages there is no habit to compare against, so nothing is claimed. */
export const SILENCE_MIN_HISTORY = 8;

/** However chatty an inbox is, it has to be quiet this long before anyone is told. */
export const SILENCE_FLOOR_MS = 12 * 3_600_000;

/** How many typical gaps of silence make a silence worth reporting. */
export const SILENCE_GAPS = 6;

/** How far back the habit is read from. */
const HABIT_WINDOW_MS = 30 * 86_400_000;

export interface InboxSilence {
  accountId: string;
  email: string;
  provider: string;
  /** Since the newest message this inbox holds. */
  quietForMs: number;
  /** The middle gap between its messages lately, which is what "normally" means here. */
  typicalGapMs: number | null;
  /** How long it would have to be quiet before this is worth saying. */
  thresholdMs: number | null;
  /** When the sync last ran at all, which separates "stalled" from "not running". */
  lastSyncAt: number | null;
  /** Quiet for longer than this inbox has ever normally been. */
  stale: boolean;
}

/**
 * The middle gap between consecutive messages, over the recent window. The
 * middle and not the mean, because one holiday or one newsletter burst owns
 * a mean and says nothing about the habit.
 */
function typicalGap(db: Db, accountId: string, since: number): number | null {
  const times = db
    .select({ at: messages.sentAt })
    .from(messages)
    .where(and(eq(messages.accountId, accountId), eq(messages.isFromOperator, false), gte(messages.sentAt, since)))
    .orderBy(messages.sentAt)
    .all()
    .map((r) => r.at);
  if (times.length < SILENCE_MIN_HISTORY) return null;
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!);
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 0 ? Math.round((gaps[mid - 1]! + gaps[mid]!) / 2) : gaps[mid]!;
}

/** Every mail inbox, and whether its silence is out of character. */
export function inboxSilences(db: Db, at: number = nowMs()): InboxSilence[] {
  const rows = db
    .select({ id: accounts.id, email: accounts.email, provider: accounts.provider })
    .from(accounts)
    .where(sql`${accounts.provider} not in ('imessage', 'whatsapp') and ${accounts.status} <> 'disconnected'`)
    .all();

  return rows.map((a) => {
    const newest =
      db
        .select({ at: sql<number | null>`max(${messages.sentAt})` })
        .from(messages)
        .where(and(eq(messages.accountId, a.id), eq(messages.isFromOperator, false)))
        .get()?.at ?? null;
    const wm = db.select({ at: watermarks.lastSyncAt }).from(watermarks).where(eq(watermarks.accountId, a.id)).get();
    const gap = typicalGap(db, a.id, at - HABIT_WINDOW_MS);
    const quietForMs = newest === null ? 0 : Math.max(0, at - newest);
    const thresholdMs = gap === null ? null : Math.max(SILENCE_FLOOR_MS, gap * SILENCE_GAPS);
    return {
      accountId: a.id,
      email: a.email,
      provider: a.provider,
      quietForMs,
      typicalGapMs: gap,
      thresholdMs,
      lastSyncAt: wm?.at ?? null,
      // An inbox with no habit on record is never called stalled: there is
      // nothing to be out of character with.
      stale: thresholdMs !== null && newest !== null && quietForMs > thresholdMs,
    };
  });
}

/** Just the ones worth saying out loud. */
export function stalledInboxes(db: Db, at: number = nowMs()): InboxSilence[] {
  return inboxSilences(db, at).filter((s) => s.stale);
}
