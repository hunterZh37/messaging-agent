"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { markOpenedAction } from "../actions";
import { openedHere } from "@/lib/openedHere";

/**
 * Records that this thread has been opened (spec 10a). It runs on mount
 * rather than during the server render, because rendering a page is not the
 * same as a person looking at it, and a server render can happen for reasons
 * that have nothing to do with the operator.
 *
 * The action itself revalidates nothing (operator, 2026-09-11: a click took
 * seconds): a page rendered again inside the request is a page the operator
 * waits for. The counts are read again afterwards instead, once the open is
 * written and the thread is already on screen, so the number on Mail or
 * Messages goes as the thread opens (operator, 2026-09-15: "the 1 on
 * Messages should be gone in real time if I open up the message").
 */
export function MarkOpened({ threadId }: { threadId: string }) {
  const router = useRouter();
  useEffect(() => {
    let live = true;
    // The list goes quiet for it now, whichever copy of the list comes back (2026-09-15).
    openedHere.mark(threadId);
    void markOpenedAction(threadId).then(() => {
      // Gone from the page by the time it lands: nothing to refresh into.
      if (live) router.refresh();
    });
    return () => {
      live = false;
    };
  }, [threadId, router]);

  return null;
}
