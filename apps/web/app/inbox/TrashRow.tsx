"use client";

import { useRef, useState, type ReactNode } from "react";
import { byTouch } from "@/lib/keys";
import { DELETE_ANIMATION_MS } from "./[threadId]/DeleteButton";
import { useSendGate } from "../queue/SendProvider";

/** The × on a row: the same glyph the History rows and the file chips wear. */
import { EyeOffIcon, TrashIcon } from "./icons";
import { MoveControl } from "./MoveControl";

/**
 * One row of the Safe-to-delete list, with an × at its right (spec 10a,
 * 2026-09-11). The × is a sibling of the row's link rather than inside it,
 * the way the History rows carry theirs, so a press on it never opens the
 * thread underneath.
 *
 * There is no confirmation and no Cancel button (operator, 2026-09-11: "just
 * delete instantly"): the row slides away and is handed to the gate, which
 * moves the thread to the provider's Trash, where it waits thirty days.
 *
 * On a touch screen the × is always showing, and a swipe to the left does
 * the same (the phone pass, 2026-09-11): the row follows the finger, and
 * past a third of its width it goes. By touch the toast carries Undo, since
 * there is no Cmd-Z.
 */
const SWIPE_COMMIT = 96;
export function TrashRow({
  threadId,
  subject,
  children,
  handledLeaves = false,
  hideable = false,
  statusList = false,
  keepable = false,
  wants,
  senders,
  ruled,
}: {
  threadId: string;
  subject: string;
  children: ReactNode;
  /** On the Need-to-reply list a thread marked handled leaves (operator, 2026-09-11: Shift). */
  handledLeaves?: boolean;
  /** A chat: it can also be hidden, leaving Celeste and staying in its app (operator, 2026-09-11). */
  hideable?: boolean;
  /** One of the four sorting lists, which a hidden thread leaves; Inbox and Messages themselves keep it (2026-09-15). */
  statusList?: boolean;
  /** Every row can be put where it belongs (operator, 2026-09-20). */
  keepable?: boolean;
  /** The rung it is on now, so the menu can mark it. */
  wants?: import("@messaging-agent/core").Wants | null;
  /** Who a standing rule would be about. */
  senders?: string[];
  /** The rung a standing rule already puts this sender on, if there is one. */
  ruled?: import("@messaging-agent/core").Wants | null;
}) {
  const { trash, leavingThreads, deletingThreads, returningThreads, handledThreads } = useSendGate();
  const [going, setGoing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [kept, setKept] = useState(false);
  const [keepError, setKeepError] = useState<string | null>(null);
  const [drag, setDrag] = useState(0);
  const touch = useRef<{ x: number; y: number; horizontal: boolean | null } | null>(null);
  if ((statusList ? leavingThreads : deletingThreads).includes(threadId)) return null;
  if (handledLeaves && handledThreads.includes(threadId)) return null;
  // Back from Cmd-Z: the slide-out runs in reverse (operator, 2026-09-11).
  const back = returningThreads.includes(threadId);

  function remove(hide = false) {
    if (going) return;
    setGoing(true);
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const undo = byTouch() || hide;
    if (reduced) {
      trash([threadId], { undo, hide });
      return;
    }
    window.setTimeout(() => trash([threadId], { undo, hide }), DELETE_ANIMATION_MS);
  }

  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0];
    if (!t) return;
    touch.current = { x: t.clientX, y: t.clientY, horizontal: null };
  }

  function onTouchMove(e: React.TouchEvent) {
    const start = touch.current;
    const t = e.touches[0];
    if (!start || !t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    // Decided once, on the first clear movement: sideways is a swipe, up or
    // down is the list scrolling, and the two never fight over the finger.
    if (start.horizontal === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      start.horizontal = Math.abs(dx) > Math.abs(dy);
    }
    if (!start.horizontal) return;
    setDrag(Math.min(0, dx));
  }

  function onTouchEnd() {
    const start = touch.current;
    touch.current = null;
    if (!start?.horizontal) return;
    if (drag <= -SWIPE_COMMIT) {
      setDrag(-window.innerWidth);
      remove();
      return;
    }
    setDrag(0);
  }

  return (
    <div
      className={`${going || kept ? "inbox-row-item going" : back ? "inbox-row-item arriving" : "inbox-row-item"}${drag < 0 ? " swiping" : ""}${hideable ? " hideable" : ""}${keepable ? " keepable" : ""}${menuOpen ? " tools-open" : ""}`}
      style={drag < 0 ? { transform: `translateX(${drag}px)` } : undefined}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      {children}
      <div className="row-tools">
      {keepable ? (
        <MoveControl
          threadId={threadId}
          subject={subject}
          wants={wants}
          senders={senders}
          ruled={ruled}
          onOpenChange={setMenuOpen}
          onMoving={() => {
            setKeepError(null);
            setKept(true);
          }}
          // A row that slid out on a write that did not happen would be a lie
          // about where the mail is. It comes back, wearing the reason.
          onFailed={(message) => {
            setKept(false);
            setKeepError(message);
          }}
        />
      ) : null}
      {keepError ? <span className="inbox-row-keep-error" role="status">{keepError}</span> : null}
      {hideable ? (
        <button
          type="button"
          className="applied-clear inbox-row-del inbox-row-hide"
          onClick={() => remove(true)}
          aria-label={`Hide ${subject || "(no subject)"}`}
          title="Hide here only (it stays in the mailbox or app)"
        >
          <EyeOffIcon />
        </button>
      ) : null}
      <button
        type="button"
        className="applied-clear inbox-row-del"
        onClick={() => remove(false)}
        aria-label={`Delete the thread ${subject || "(no subject)"}`}
        title="Delete this thread"
      >
        <TrashIcon />
      </button>
      </div>
    </div>
  );
}
