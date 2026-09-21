"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { unhideThreadsAction } from "../actions";
import { useSendGate } from "../../queue/SendProvider";
import { EyeOffIcon } from "../icons";

/**
 * On a hidden thread (2026-09-15): puts it back on Need to reply, Unopened
 * and Safe to delete. It never left Inbox or Messages.
 */
export function UnhideButton({ threadId, chat = false }: { threadId: string; chat?: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const gate = useSendGate();

  function onClick() {
    setError(null);
    startTransition(async () => {
      const r = await unhideThreadsAction([threadId]);
      if ("error" in r) return setError(r.error);
      gate.say(chat ? "Out of Archive · back on the chat lists" : "Out of Archive · back on the sorting lists");
      router.refresh();
    });
  }

  return (
    <>
      <button type="button" className="btn quiet" onClick={onClick} disabled={pending} title="Out of Archive, back on the sorting lists">
        <EyeOffIcon />
        Unarchive
      </button>
      {error ? <span className="error">{error}</span> : null}
    </>
  );
}
