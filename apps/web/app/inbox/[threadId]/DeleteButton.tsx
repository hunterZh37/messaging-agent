"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { byTouch, isDeleteKey, isHideKey } from "@/lib/keys";
import { useSendGate } from "../../queue/SendProvider";
import { EyeOffIcon, TrashIcon } from "../icons";

/** How long the thread takes to leave the screen; matches `.inbox-detail.deleting` in globals.css. */
export const DELETE_ANIMATION_MS = 360;

/** One thread further down the run, and where the page goes to show it. */
export interface Following {
  id: string;
  href: string;
}

/**
 * Quiet "Delete" in the thread's action row, beside Mark handled (spec 10a,
 * 2026-09-11). Offered on any inbox thread, not only the safe-to-delete ones:
 * the sorter's verdict says which mail to look at, and the operator decides
 * what goes.
 *
 * It hands the thread to the send gate at once (operator, 2026-09-11: no
 * countdown, "just delete instantly"; nothing is destroyed, the mail waits
 * thirty days in the provider's Trash), lets the thread sweep off the screen
 * (ThreadPane reads that from the gate), and moves to the neighbour as "No
 * reply needed" does.
 *
 * Pressed again before the next thread has shown up, it deletes that next
 * thread, and the one after on the press after that (operator, 2026-09-11:
 * "delete very fast"): the run walks `following`, the list in the order the
 * neighbour rule would have taken, and the page goes to wherever the run has
 * got to. Each press past the first goes there at once, since the sweep is
 * long over by the time a fast run is under way.
 */
export function DeleteButton({
  threadId,
  following,
  emptyHref,
  hide = false,
  stay = false,
}: {
  threadId: string;
  following: Following[];
  /** Where to go when the list runs out. */
  emptyHref: string;
  /** Hide rather than delete (operator, 2026-09-11): the thread leaves Celeste and stays in its app or mailbox. The = key. */
  hide?: boolean;
  /** Hide from Inbox or Messages itself: the thread stays, so the page does too and reads itself again (2026-09-15). */
  stay?: boolean;
}) {
  const { trash, leavingThreads } = useSendGate();
  const router = useRouter();
  // The thread the next press deletes: this page's, then down the run.
  const cursor = useRef<string | null>(threadId);
  const gone = useRef(new Set<string>());
  const pending = useRef<number | null>(null);
  const leaving = useRef(leavingThreads);
  leaving.current = leavingThreads;

  function onDelete() {
    const target = cursor.current;
    if (!target) return;
    // By touch there is no Cmd-Z, so the toast carries the way back.
    trash([target], { undo: byTouch() || hide, hide });
    if (stay) {
      window.setTimeout(() => router.refresh(), 900);
      return;
    }
    gone.current.add(target);
    const next = following.find((f) => !gone.current.has(f.id) && !leaving.current.includes(f.id)) ?? null;
    cursor.current = next?.id ?? null;
    const href = next?.href ?? emptyHref;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (pending.current !== null || reduced) {
      if (pending.current !== null) window.clearTimeout(pending.current);
      pending.current = null;
      router.push(href);
      return;
    }
    pending.current = window.setTimeout(() => {
      pending.current = null;
      router.push(href);
    }, DELETE_ANIMATION_MS);
  }

  // The neighbour is fetched ahead, so the pane is not left empty between
  // the sweep and the next thread.
  useEffect(() => {
    if (following[0]) router.prefetch(following[0].href);
  }, [router, following]);

  // The Delete key does what the button does, and = hides (operator,
  // 2026-09-11), when nothing else has the keyboard: no field focused, no
  // dialog open.
  // No bare Shift any more (operator, 2026-09-15): held while clicking or
  // scrolling, it read as a tap and hid thread after thread, fifteen in two
  // minutes. Hide is = alone.
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (!(hide ? isHideKey(ev) : isDeleteKey(ev))) return;
      if (document.querySelector(".dialog-scrim")) return;
      ev.preventDefault();
      onDelete();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <button type="button" className="btn quiet" onClick={onDelete} title={hide ? "Hide from Need to reply, Unopened and Safe to delete; it stays in Inbox" : undefined}>
      {hide ? <EyeOffIcon /> : <TrashIcon />}
      {hide ? "Hide" : "Delete"}
      <kbd>{hide ? "=" : "⌫"}</kbd>
    </button>
  );
}
