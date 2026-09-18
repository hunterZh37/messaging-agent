/** One thread's messages in the list: the one that stands for it, and the rest. */
export interface ThreadGroup<T> {
  threadId: string;
  /** The newest message of the thread that the list holds: the row shown collapsed. */
  latest: T;
  /** The rest, newest first, hidden until the operator opens the group. */
  older: T[];
}

/**
 * One row per thread rather than one per message (spec 10a). A reply and the
 * message it answers are the same conversation, and showing them side by side
 * as equals reads as two pieces of mail that happen to share a subject. The
 * thread keeps the place of its newest message, which is where the operator
 * expects to find it, and everything older folds underneath.
 */
export function groupByThread<T extends { thread: { id: string }; message: { sentAt: number } }>(rows: T[]): ThreadGroup<T>[] {
  const groups = new Map<string, T[]>();
  const order: string[] = [];
  for (const row of rows) {
    const id = row.thread.id;
    if (!groups.has(id)) {
      groups.set(id, []);
      order.push(id);
    }
    groups.get(id)!.push(row);
  }

  return order.map((threadId) => {
    // The caller sorts newest first, but a group's own order is decided here
    // rather than assumed, so the row that stands for a thread is its newest
    // whatever order the rows arrived in.
    const sorted = [...groups.get(threadId)!].sort((a, b) => b.message.sentAt - a.message.sentAt);
    return { threadId, latest: sorted[0]!, older: sorted.slice(1) };
  });
}

/**
 * Where the focus goes when the row being looked at leaves the list: the one
 * below it, or the one above when it was last, or nowhere when it was alone
 * (operator, 2026-09-10: "the very next email should be focused"). The same
 * rule serves both lists: threads leaving Waiting for reply, and drafts
 * leaving the queue on Skip or Send.
 */
export function neighbourThread(threadIds: string[], current: string): string | null {
  const i = threadIds.indexOf(current);
  if (i === -1) return threadIds[0] ?? null;
  return threadIds[i + 1] ?? threadIds[i - 1] ?? null;
}

/**
 * The order a run of deletes walks from the thread being looked at (operator,
 * 2026-09-11: "delete very fast"): each press takes the next thread the
 * neighbour rule would have landed on, below first, then upwards from the
 * nearest, without waiting for the page to show it. The current thread is
 * not on the list.
 */
export function runAfter(threadIds: string[], current: string): string[] {
  const i = threadIds.indexOf(current);
  if (i === -1) return [...threadIds];
  return [...threadIds.slice(i + 1), ...threadIds.slice(0, i).reverse()];
}
