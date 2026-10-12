"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useSendGate } from "../queue/SendProvider";
import { archivableCountAction, archiveAllAction, unhideThreadsAction, type DisposableScope } from "./actions";

/**
 * "Archive all · N" on the Worth Knowing view, where "Delete all" sits on
 * Safe-to-delete and "Mark all opened" on Unopened (operator, 2026-10-12: "the
 * archive button should be at the same spot as Delete All").
 *
 * It belongs in that row because it is the same kind of act: one press over
 * the list in front of them, narrowed by the window, the project and the
 * inbox exactly as the list is. Putting it here settled a mismatch the first
 * version had, where the button counted the whole mailbox while the row
 * beside it counted the view.
 *
 * The count is the threads that would actually move, not the threads on
 * screen: anything they have not read is held back, and saying N when N-3
 * will go would be a lie told by a button.
 */
export function ArchiveAll({ scope }: { scope: DisposableScope }) {
  const { say } = useSendGate();
  const router = useRouter();
  const [count, setCount] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let dropped = false;
    void archivableCountAction(scope).then((n) => {
      if (!dropped) setCount(n);
    });
    return () => {
      dropped = true;
    };
    // The scope is a plain object rebuilt each render; its contents are what
    // matter, not its identity.
  }, [JSON.stringify(scope)]);

  function archiveAll() {
    startTransition(async () => {
      const r = await archiveAllAction(scope);
      if ("error" in r) {
        say(`Could not archive: ${r.error}`);
        return;
      }
      if (r.moved === 0) {
        say("Nothing to archive");
        return;
      }
      setCount(0);
      say(`Archived ${r.moved} ${r.moved === 1 ? "thread" : "threads"}`, {
        undo: async () => {
          await unhideThreadsAction(r.threadIds);
          router.refresh();
        },
      });
      router.refresh();
    });
  }

  if (count === null || count === 0) return null;
  return (
    <button
      type="button"
      className="chip edit"
      onClick={archiveAll}
      disabled={pending}
      title="Archive every thread here you have read. Anything you have not opened stays."
    >
      <span>{pending ? "Archiving…" : `Archive all · ${count}`}</span>
    </button>
  );
}
