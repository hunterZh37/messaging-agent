"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useSendGate } from "../queue/SendProvider";
import { moveAllToKnowingAction, owedCountAction, restoreVerdictsAction, type DisposableScope } from "./actions";

/**
 * "Move all to Worth Knowing · N" on the Reply / Action Required view
 * (operator, 2026-10-12), beside the same bulk buttons the other lists carry.
 *
 * It is the one bulk act here that changes what Celeste thinks rather than
 * where the mail sits, which is why it says the destination in full rather
 * than borrowing the shorter shape of "Delete all". Pressing it is the
 * operator saying the sorter was wrong about a whole row at once, and the row
 * it empties is the one that otherwise has to be argued with thread by thread.
 */
export function MoveAllToKnowing({ scope }: { scope: DisposableScope }) {
  const { say } = useSendGate();
  const router = useRouter();
  const [count, setCount] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let dropped = false;
    void owedCountAction(scope).then((n) => {
      if (!dropped) setCount(n);
    });
    return () => {
      dropped = true;
    };
  }, [JSON.stringify(scope)]);

  function moveAll() {
    startTransition(async () => {
      const r = await moveAllToKnowingAction(scope);
      if ("error" in r) {
        say(`Could not move: ${r.error}`);
        return;
      }
      if (r.moved === 0) {
        say("Nothing to move");
        return;
      }
      setCount(0);
      say(`Moved ${r.moved} to Worth Knowing`, {
        undo: async () => {
          await restoreVerdictsAction(r.previous);
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
      onClick={moveAll}
      disabled={pending}
      title="Say these ask nothing of you. They stay in the inbox, on the Worth Knowing row."
    >
      <span>{pending ? "Moving…" : `Move all to Worth Knowing · ${count}`}</span>
    </button>
  );
}
