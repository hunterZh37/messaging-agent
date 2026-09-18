"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { restoreThreadsAction } from "../actions";
import { useSendGate } from "../../queue/SendProvider";

/**
 * On a thread in Deleted items: the way back to the inbox that does not
 * depend on Cmd-Z still remembering the delete (stress audit, 2026-09-11:
 * a deleted thread's page offered Draft, Mark handled and Move, and no way
 * out of Trash). The same restore Cmd-Z uses, then the next deleted thread
 * takes its place.
 */
export function PutBackButton({ threadId, nextHref, chat = false }: { threadId: string; /** Where to go once the thread has left Deleted items. */ nextHref: string; /** A chat goes back to Messages, not the inbox (2026-09-11). */ chat?: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const gate = useSendGate();

  function onClick() {
    setError(null);
    startTransition(async () => {
      const r = await restoreThreadsAction([threadId]);
      if ("error" in r) {
        setError(r.error);
        return;
      }
      if (r.moved === 0) {
        setError("The mailbox did not give it back.");
        return;
      }
      gate.say(chat ? "Restored to Messages" : "Restored to the inbox");
      router.push(nextHref);
    });
  }

  return (
    <>
      <button type="button" className="btn" onClick={onClick} disabled={pending}>
        {pending ? "Restoring…" : chat ? "Restore to Messages" : "Restore to inbox"}
      </button>
      {error ? <div className="error">{error}</div> : null}
    </>
  );
}
