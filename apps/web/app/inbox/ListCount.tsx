"use client";

import { useEffect, useMemo, useRef } from "react";
import { goneByKey, listAdjust } from "@/lib/listAdjust";
import { useSendGate } from "../queue/SendProvider";

/**
 * Tells the counts how many of this list's rows have already left them
 * (2026-09-15, and the tree rows beside it on 2026-09-20). A card leaves the
 * moment it is deleted, hidden or handled; the numbers came from the server
 * and only move once the provider has finished and the page is read again.
 *
 * Every number a row is part of, not only the one over the list it is in:
 * deleting from Safe to Delete took one off that row and left Inbox standing
 * still, and deleting from the Inbox itself moved nothing at all. Each row
 * carries the tree rows it is counted in, read on the server from the lists'
 * own conditions, so the tree takes them all off at once.
 *
 * On the fresh page those rows are gone from the list, so what is taken off
 * is zero again: nothing is ever taken off twice.
 */
export function ListCount({ rows, handledLeaves = false }: {
  rows: { threadId: string; keys: string[] }[];
  handledLeaves?: boolean;
}) {
  const { leavingThreads, handledThreads, returningThreads } = useSendGate();
  const gone = useMemo(() => {
    const back = new Set(returningThreads);
    const leaving = [...leavingThreads, ...(handledLeaves ? handledThreads : [])].filter((id) => !back.has(id));
    return goneByKey(rows, leaving);
  }, [rows, leavingThreads, handledThreads, returningThreads, handledLeaves]);

  // What this list last took off, so a key it no longer touches is put back
  // rather than left short for as long as the page stands.
  const applied = useRef<string[]>([]);
  useEffect(() => {
    for (const key of applied.current) if (!gone.has(key)) listAdjust.set(key, null);
    for (const [key, value] of gone) listAdjust.set(key, value);
    applied.current = [...gone.keys()];
  }, [gone]);
  useEffect(() => {
    const held = applied;
    return () => {
      for (const key of held.current) listAdjust.set(key, null);
    };
  }, []);
  return null;
}
