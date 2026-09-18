"use client";

import { useEffect, useMemo } from "react";
import { goneFromList, listAdjust } from "@/lib/listAdjust";
import { useSendGate } from "../queue/SendProvider";

/**
 * Tells the counts how many of this list's rows have already left it
 * (2026-09-15): the tree row beside it and "Delete all" drop the moment a
 * card does, not when the provider has finished. `treeKey` is the tree row
 * this list is, `folder:status`.
 */
export function ListCount({ treeKey, rowThreadIds, handledLeaves = false }: { treeKey: string; rowThreadIds: string[]; handledLeaves?: boolean }) {
  const { leavingThreads, handledThreads, returningThreads } = useSendGate();
  const gone = useMemo(() => {
    const back = new Set(returningThreads);
    const leaving = [...leavingThreads, ...(handledLeaves ? handledThreads : [])].filter((id) => !back.has(id));
    return goneFromList(rowThreadIds, leaving);
  }, [rowThreadIds, leavingThreads, handledThreads, returningThreads, handledLeaves]);

  useEffect(() => {
    listAdjust.set(treeKey, gone);
  }, [treeKey, gone]);
  useEffect(() => () => listAdjust.set(treeKey, null), [treeKey]);
  return null;
}
