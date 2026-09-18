"use client";

import type { ReactNode } from "react";
import { useSendGate } from "../../queue/SendProvider";

/**
 * The thread's pane, which sweeps off the screen once the thread is deleted
 * (operator, 2026-09-11). Whether it is going is read from the send gate
 * rather than set on the element by hand: the page reads itself again when
 * the delete lands, and a class put on the element by hand did not survive
 * that, so the thread came back for a moment before its neighbour arrived.
 */
export function ThreadPane({ threadId, children, statusList = false }: { threadId: string; children: ReactNode; /** Opened from a sorting list, which a hide takes the thread out of (2026-09-15). */ statusList?: boolean }) {
  const { leavingThreads, deletingThreads, returningThreads, handledThreads } = useSendGate();
  const going = (statusList ? leavingThreads : deletingThreads).includes(threadId);
  // Marked handled (operator, 2026-09-11: Shift): the same sweep, in the
  // colour of a thing done rather than a thing thrown away.
  const handled = !going && handledThreads.includes(threadId);
  // Back from Cmd-Z: the sweep runs in reverse (operator, 2026-09-11).
  const back = !going && returningThreads.includes(threadId);
  // `thread-detail` scopes the phone-only room the sticky action bar needs at
  // the foot of this pane (spec 10a, 2026-09-11) to the thread page alone: the
  // Drafts page reuses `.inbox-detail` for its own pane, which has no such
  // bar and must not gain the padding meant for this one.
  const className = `inbox-detail thread-detail${going ? " deleting" : handled ? " handling" : back ? " returning" : ""}`;
  return <div className={className}>{children}</div>;
}
