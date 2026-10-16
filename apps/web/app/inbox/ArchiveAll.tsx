"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useSendGate } from "../queue/SendProvider";
import { archivableCountAction, archiveAllAction, unhideThreadsAction, type ArchiveList, type DisposableScope } from "./actions";
import { archiveAllLabel } from "@/lib/folders";

/**
 * "Archive all · N", beside "Delete all" on Safe to Delete and on the Worth
 * Knowing view (operator, 2026-10-12: "the archive button should be at the
 * same spot as Delete All", then "under Safe to Delete also build a button
 * right next to Delete All: Archive All").
 *
 * Two buttons on one list, for the two things you can do with mail you are
 * finished with: throw it out, or put it away. Which one they reach for is the
 * only question, so they sit together and read alike.
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
export function ArchiveAll({ scope, list = "knowing" }: { scope: DisposableScope; list?: ArchiveList }) {
  const { say } = useSendGate();
  const router = useRouter();
  const [count, setCount] = useState<{ archivable: number; inView: number } | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let dropped = false;
    void archivableCountAction(scope, list).then((n) => {
      if (!dropped) setCount(n);
    });
    return () => {
      dropped = true;
    };
    // The scope is a plain object rebuilt each render; its contents are what
    // matter, not its identity.
  }, [JSON.stringify(scope), list]);

  function archiveAll() {
    startTransition(async () => {
      const r = await archiveAllAction(scope, list);
      if ("error" in r) {
        say(`Could not archive: ${r.error}`);
        return;
      }
      if (r.moved === 0) {
        say("Nothing to archive");
        return;
      }
      setCount({ archivable: 0, inView: 0 });
      say(`Archived ${r.moved} ${r.moved === 1 ? "thread" : "threads"}`, {
        undo: async () => {
          await unhideThreadsAction(r.threadIds);
          router.refresh();
        },
      });
      router.refresh();
    });
  }

  const label = count ? archiveAllLabel(count.archivable, count.inView) : null;
  if (!label) return null;
  return (
    <button
      type="button"
      className="chip edit"
      onClick={archiveAll}
      disabled={pending}
      title={
        list === "disposable"
          ? "Put these away instead of deleting them. They stay findable in the Archive."
          : count && count.archivable < count.inView
            ? `Archive the ${count.archivable} you have read. The other ${count.inView - count.archivable} stay until you open them.`
            : "Archive every thread here you have read. Anything you have not opened stays."
      }
    >
      <span>{pending ? "Archiving…" : label}</span>
    </button>
  );
}
