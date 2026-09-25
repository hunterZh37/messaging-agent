import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { drafts, threads } from "../db/schema";

/**
 * Where a link from Alex lands (2026-09-23).
 *
 * The draft is what the operator wants when one is waiting: it is the thing
 * the action was about. Once it has been sent or deleted there is nothing to
 * open, so the conversation itself answers instead, and the link a week old
 * still goes somewhere. A thread that no longer exists at all sends them to
 * the inbox rather than to an error.
 */
export function landingFor(db: Db, threadId: string): string {
  const thread = db.select({ id: threads.id, accountId: threads.accountId }).from(threads).where(eq(threads.id, threadId)).get();
  if (!thread) return "/inbox";

  const waiting = db
    .select({ id: drafts.id })
    .from(drafts)
    .where(and(eq(drafts.threadId, threadId), eq(drafts.status, "pending")))
    .get();

  // The queue, on the account the draft belongs to, with that card open: the
  // operator asked for the mail "selected already".
  if (waiting) return `/drafts?draft=${encodeURIComponent(waiting.id)}&account=${encodeURIComponent(thread.accountId)}`;
  return `/inbox/${encodeURIComponent(threadId)}`;
}
