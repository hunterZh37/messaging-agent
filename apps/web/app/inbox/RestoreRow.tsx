"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { restoreThreadsAction } from "./actions";
import { useSendGate } from "../queue/SendProvider";
import { RestoreIcon } from "./icons";

/**
 * One row of Deleted items with a Restore at its right (operator, 2026-09-15:
 * "from deleted items, there should be a button where I can restore the
 * deleted email or message"). The same restore the thread page's button and
 * Cmd-Z use: mail goes back to its inbox, a chat back to Messages. The row
 * slides away at once and comes back if the mailbox refuses.
 */
export function RestoreRow({ threadId, subject, chat, children }: { threadId: string; subject: string; chat: boolean; children: ReactNode }) {
  const [going, setGoing] = useState(false);
  const [gone, setGone] = useState(false);
  const [, startTransition] = useTransition();
  const gate = useSendGate();
  const router = useRouter();
  if (gone) return null;

  function restore() {
    if (going) return;
    setGoing(true);
    startTransition(async () => {
      const r = await restoreThreadsAction([threadId]);
      if ("error" in r || r.moved === 0) {
        setGoing(false);
        gate.say("error" in r ? `Could not restore: ${r.error}` : "The mailbox did not give it back.");
        return;
      }
      setGone(true);
      gate.say(chat ? "Restored to Messages" : "Restored to the inbox");
      router.refresh();
    });
  }

  return (
    <div className={`inbox-row-item restorable${going ? " going" : ""}`}>
      {children}
      <button
        type="button"
        className="applied-clear inbox-row-del inbox-row-restore"
        onClick={restore}
        aria-label={`Restore ${subject || "(no subject)"}`}
        title={chat ? "Restore to Messages" : "Restore to the inbox"}
      >
        <RestoreIcon />
      </button>
    </div>
  );
}
