import { and, eq, isNull, sql } from "drizzle-orm";
import { now as nowMs, type Db } from "../db/client";
import { messages, sorts, threads } from "../db/schema";
import { threadUnreadFor } from "./inbox";
import { hideThreads } from "./trash";

/**
 * Moving what has gone quiet out of working memory and into storage (operator,
 * 2026-10-12: "Inbox is like RAM and Archive is like SSD. Inbox is supposed to
 * be temporary and Archive is supposed to be long-term storage").
 *
 * The rule that matters most is the one that holds things back. Their actual
 * goal is not an empty inbox, which a button can always deliver, but this: "I
 * want to have the confidence that I have personally seen every single email
 * out there." So a thread they have never opened never sweeps, however old and
 * however little it asks of them. An inbox that empties on its own is not an
 * inbox they have read; it is one that got quieter.
 *
 * Nothing here runs by itself. The sorter has never written `hidden_at` and
 * still cannot — this is a button they press.
 */

/**
 * How long a thread must have been silent to count as stale. A fortnight,
 * chosen against their own mailbox rather than guessed: of 311 Worth Knowing
 * threads, 262 had been quiet this long and 155 were past ninety days, so the
 * pile is dead whatever the number — this only decides how much recent mail
 * still gets their eyes.
 */
export const SWEEP_QUIET_DAYS = 14;

const DAY_MS = 86_400_000;

/**
 * The threads a sweep would take. Four conditions, and the first is the
 * promise the rest are in service of:
 *
 * - they have seen it: opened, and nothing has arrived since. Not merely
 *   "opened once" — a thread read last year with mail from last month in it
 *   is a thread with unseen mail, and the sidebar's Unopened row already
 *   says so
 * - nothing new has arrived for `days`, read from the thread's own clock
 *   rather than any message's: an old thread with a reply yesterday is live
 * - its newest inbox message is the sorter's `knowing` — a thread whose latest
 *   word needs a reply stays, however much quiet mail sits behind it
 * - it is in the inbox and not already archived
 */
export function sweepable(db: Db, opts: { days?: number; accountId?: string; now?: () => number } = {}): string[] {
  const clock = opts.now ?? nowMs;
  const quietBefore = clock() - (opts.days ?? SWEEP_QUIET_DAYS) * DAY_MS;

  // The verdict on the newest thing that reached the inbox in this thread,
  // which is the one the inbox row is showing them. Left-joined, so a newest
  // message the sorter has never judged comes back null and holds the thread
  // back — an inner join silently skipped it and read the verdict off an older
  // message instead, which archived threads on a judgment nobody had made
  // (review, 2026-10-12, found in their own mailbox). Ties on `sent_at` break
  // on the id, the way `latestInboxInThread` does, so the answer is the same
  // answer every time it is asked.
  const newestVerdict = sql<string | null>`(
    select s.wants from ${messages} m2
    left join ${sorts} s on s.message_id = m2.id
    where m2.thread_id = ${threads.id} and m2.folder = 'inbox'
    order by m2.sent_at desc, m2.id desc limit 1
  )`;

  const rows = db
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        isNull(threads.hiddenAt),
        sql`${threads.lastMessageAt} <= ${quietBefore}`,
        sql`${newestVerdict} = 'knowing'`,
        // Seen, in the sense the sidebar's Unopened row means it: opened, and
        // nothing has landed since. The promise this whole button rests on.
        sql`not ${threadUnreadFor(sql`${threads.id}`)}`,
        ...(opts.accountId ? [eq(threads.accountId, opts.accountId)] : []),
      ),
    )
    .all();
  return rows.map((r) => r.id);
}

/**
 * Sweeps them, and says exactly which went. `hideThreads` stamps every thread
 * in one batch with the same `hidden_at`, so that stamp identifies this sweep
 * and nothing else — an undo puts back what this button moved, never a thread
 * they archived by hand last week.
 */
export function sweepWorthKnowing(
  db: Db,
  opts: { days?: number; accountId?: string; now?: () => number } = {},
): { moved: number; threadIds: string[]; at: number } {
  const clock = opts.now ?? nowMs;
  const threadIds = sweepable(db, opts);
  if (threadIds.length === 0) return { moved: 0, threadIds: [], at: 0 };
  const at = clock();
  const { moved } = hideThreads(db, threadIds, () => at);
  return { moved, threadIds, at };
}
