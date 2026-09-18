"use client";

import { useSyncExternalStore } from "react";
import { listAdjust } from "@/lib/listAdjust";

/** Re-renders whenever any list says how much of it has gone (2026-09-15). */
export function useListAdjustVersion(): number {
  return useSyncExternalStore(listAdjust.subscribe, listAdjust.version, () => 0);
}
