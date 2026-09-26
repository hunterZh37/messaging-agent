"use client";

import { useRef, type ReactNode } from "react";
import { openedPane, paneSweep } from "@/lib/queue";
import { useSendGate } from "../../queue/SendProvider";

/**
 * The thread's pane, which sweeps off the screen once the thread is deleted
 * (operator, 2026-09-11). Whether it is going is read from the send gate
 * rather than set on the element by hand: the page reads itself again when
 * the delete lands, and a class put on the element by hand did not survive
 * that, so the thread came back for a moment before its neighbour arrived.
 *
 * It sweeps on the change, not on what the gate happens to hold: a thread
 * this session already deleted is on that list for the rest of the session,
 * and Deleted items is a list of nothing else, so opening one of its cards
 * put the pane straight into the end of the animation — `opacity: 0`, and
 * nothing to read (operator, 2026-09-25).
 */
export function ThreadPane({ threadId, children, statusList = false }: { threadId: string; children: ReactNode; /** Opened from a sorting list, which a hide takes the thread out of (2026-09-15). */ statusList?: boolean }) {
  const { leavingThreads, deletingThreads, returningThreads, handledThreads } = useSendGate();
  const going = (statusList ? leavingThreads : deletingThreads).includes(threadId);
  // Marked handled (operator, 2026-09-11: Shift): the same sweep, in the
  // colour of a thing done rather than a thing thrown away.
  const handled = handledThreads.includes(threadId);
  // Back from Cmd-Z: the sweep runs in reverse (operator, 2026-09-11).
  const back = returningThreads.includes(threadId);
  // What was already true when this thread was opened. A pane only sweeps for
  // a thread that leaves while it is being looked at. React keeps this element
  // across a move from one thread to the next, so the answer is kept per
  // thread rather than per pane: otherwise a delete after reading a deleted
  // one would not sweep at all.
  const opened = useRef({ threadId, going, handled });
  opened.current = openedPane(opened.current, { threadId, going, handled });
  // `thread-detail` scopes the phone-only room the sticky action bar needs at
  // the foot of this pane (spec 10a, 2026-09-11) to the thread page alone: the
  // Drafts page reuses `.inbox-detail` for its own pane, which has no such
  // bar and must not gain the padding meant for this one.
  const className = `inbox-detail thread-detail${paneSweep({ going, handled, back }, opened.current)}`;
  return <div className={className}>{children}</div>;
}
