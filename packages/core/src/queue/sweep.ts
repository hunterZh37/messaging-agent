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
 * How long a thread must have been silent before the button will take it.
 * Nothing: "I'm saying there should be a button where I can just one-click and
 * archive everything" (operator, 2026-10-12, having asked for that twice).
 *
 * A fortnight sat here first, which was caution of mine rather than anything
 * they asked for, and it was the wrong caution. The protection they wanted was
 * never about age — it is that they have seen it, which `sweepable` enforces
 * absolutely and which no window can switch off. Age only decided how long
 * read mail that wants nothing from them sat in the way of mail that does.
 *
 * Callers can still ask for a window, and the tests still cover one, because
 * "everything older than N" is a reasonable thing to want later. The button
 * does not ask.
 */
export const SWEEP_QUIET_DAYS = 0;

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
 *   rather than any message's: an old thread with a reply yesterday is live.
 *   Zero by default, so the button takes everything they have read
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

/**
 * The same question asked of a list someone is already looking at: of these
 * threads, which may leave? The button lives in the list header beside
 * "Delete all" (operator, 2026-10-12: "the archive button should be at the
 * same spot as Delete All"), so the view decides the set — its window, its
 * project, its inbox — and this decides only what the guarantee permits out
 * of it.
 *
 * Splitting it this way is what keeps the promise in one place. The view's
 * query lives with the other bulk lists in `inbox.ts` and knows nothing about
 * sweeping; every rule about what may be archived is here, and a new caller
 * cannot route around it by assembling its own list.
 */
export function sweepableAmong(db: Db, threadIds: string[], opts: { days?: number; now?: () => number } = {}): string[] {
  if (threadIds.length === 0) return [];
  const allowed = new Set(sweepable(db, opts));
  return threadIds.filter((id) => allowed.has(id));
}

/**
 * Archives exactly the threads it is given, asking nothing about them. One
 * `hidden_at` for the batch, so an undo returns this press and nothing else.
 *
 * This is what "Archive all" does on Safe to Delete (operator, 2026-10-12:
 * "under Safe to Delete also build a button right next to Delete All:
 * Archive All"), and it deliberately applies no guarantee. The button beside
 * it deletes these same threads outright; holding one back for being unread
 * would protect it from the gentler of the two and not from the other, which
 * protects nothing and only makes the pair behave in ways nobody could
 * predict. On Worth Knowing the guarantee still holds, through `sweepAmong`.
 */
export function archiveThreads(
  db: Db,
  threadIds: string[],
  opts: { now?: () => number } = {},
): { moved: number; threadIds: string[]; at: number } {
  if (threadIds.length === 0) return { moved: 0, threadIds: [], at: 0 };
  const at = (opts.now ?? nowMs)();
  const { moved } = hideThreads(db, threadIds, () => at);
  return { moved, threadIds, at };
}

/**
 * Archives the ones it may, out of the list it was given, and says which went.
 * Nothing they have not read leaves this way.
 */
export function sweepAmong(
  db: Db,
  threadIds: string[],
  opts: { days?: number; now?: () => number } = {},
): { moved: number; threadIds: string[]; at: number } {
  return archiveThreads(db, sweepableAmong(db, threadIds, opts), opts);
}
