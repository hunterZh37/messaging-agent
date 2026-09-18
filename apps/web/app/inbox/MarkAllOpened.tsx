"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { useSendGate } from "../queue/SendProvider";
import { markAllOpenedAction, restoreThreadOpensAction, type UnopenedScope } from "./actions";

/**
 * "Mark all opened · N" on the Unopened view (spec 10a, 2026-09-09): the
 * threads in the view on screen, resolved when it is pressed rather than
 * when the page was drawn. No confirm: it is said in the app's toasts with
 * an Undo, and the Undo puts every thread back to what it said before.
 *
 * The toast used to be this component's own, and the action re-rendered
 * the page around it, so the Undo was gone before it could be pressed
 * (stress audit, 2026-09-11). It goes through the gate now, which outlives
 * the page.
 */
export function MarkAllOpened({ scope, count }: { scope: UnopenedScope; count: number }) {
  const router = useRouter();
  const { say } = useSendGate();
  const [pending, startTransition] = useTransition();

  function markAll() {
    startTransition(async () => {
      const result = await markAllOpenedAction(scope);
      if (result.marked > 0) {
        say(result.marked === 1 ? "1 thread marked opened" : `${result.marked} threads marked opened`, {
          undo: async () => {
            await restoreThreadOpensAction(result.previous);
            router.refresh();
          },
        });
      }
      router.refresh();
    });
  }

  return (
    <button
      type="button"
      className="chip edit mark-all"
      onClick={markAll}
      disabled={pending || count === 0}
      aria-label={`Mark all opened, ${count}`}
      title="Mark all opened"
    >
      {/* On a phone a double tick and the count, so the window keeps the row (2026-09-15). */}
      <svg className="mark-all-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M2 12.5l4.5 4.5L15 8.5" />
        <path d="M11.5 16l1 1L21 8.5" />
      </svg>
      <span className="mark-all-long">{pending ? "Marking…" : `Mark all opened · ${count}`}</span>
      <span className="mark-all-short">{pending ? "…" : count}</span>
    </button>
  );
}
