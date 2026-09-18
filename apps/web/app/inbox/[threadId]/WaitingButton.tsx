"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setThreadWaitingAction } from "../actions";

/**
 * On a thread the operator sent last: "No reply needed" takes it out of
 * Waiting for reply (operator, 2026-09-10); once out, the same spot offers
 * the way back. Quiet, beside Mark handled.
 */
export function WaitingButton({ threadId, dismissed, nextHref }: { threadId: string; dismissed: boolean; /** Where to go once the thread has left the list. */ nextHref: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function onClick() {
    setError(null);
    startTransition(async () => {
      const r = await setThreadWaitingAction(threadId, dismissed);
      if ("error" in r) {
        setError(r.error);
        return;
      }
      // Dismissed: the thread is gone from Waiting, so the next one takes
      // its place. Put back: it is still here, so stay.
      if (dismissed) router.refresh();
      else router.push(nextHref);
    });
  }

  return (
    <>
      <button type="button" className="btn quiet" onClick={onClick} disabled={pending}>
        {pending ? "Saving…" : dismissed ? "Waiting for reply again" : "No reply needed"}
      </button>
      {error ? <div className="error">{error}</div> : null}
    </>
  );
}
