"use client";

import { useTransition } from "react";
import { useSendGate } from "../queue/SendProvider";
import { useListAdjustVersion } from "../queue/useListAdjust";
import { lessGone, listAdjust } from "@/lib/listAdjust";
import { disposableThreadsAction, hiddenThreadsAction, type DisposableScope } from "./actions";

/**
 * "Delete all · N" on the Safe-to-delete view (spec 10a, 2026-09-11), where
 * "Mark all opened" sits on Unopened, and on Hidden as well (operator,
 * 2026-09-18). It acts on what the operator is looking at, not on the whole
 * inbox: the window, the project and the money side all narrow it, and N is
 * the threads in that view.
 *
 * Both lists get the same button rather than a second one wearing a different
 * name, because it is the same act on a different set: the only thing that
 * changes is which query answers "all".
 *
 * It does not delete anything itself. It hands the threads to the send gate,
 * which is where every write that reaches the world goes through, and the
 * mail moves at once to the provider's Trash, where it waits thirty days.
 */
export function DeleteAll({ scope, count: served, list = "disposable" }: { scope: DisposableScope; count: number; list?: "disposable" | "hidden" }) {
  const { trash } = useSendGate();
  // Less the threads the list beneath has already let go of (2026-09-15).
  useListAdjustVersion();
  const count = lessGone(served, listAdjust.get(`${scope.folder ?? "inbox"}:${list}`)?.threads);
  const [pending, startTransition] = useTransition();

  function deleteAll() {
    startTransition(async () => {
      const threadIds = await (list === "hidden" ? hiddenThreadsAction(scope) : disposableThreadsAction(scope));
      if (threadIds.length > 0) trash(threadIds);
    });
  }

  return (
    <button type="button" className="chip edit" onClick={deleteAll} disabled={pending || count === 0}>
      <span>{pending ? "Deleting…" : `Delete all · ${count}`}</span>
    </button>
  );
}
