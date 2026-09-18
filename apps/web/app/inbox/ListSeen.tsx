"use client";

import { useEffect } from "react";
import { SEEN_KEY } from "./NewBadge";

/** A visit is over once the list has been out of sight this long; what arrives after that is New on the next visit. */
const VISIT_GAP_MS = 60_000;

/**
 * Keeps, per list, when the operator last looked (operator, 2026-09-11: New
 * on rows that arrived since). While the list is on screen its "last seen"
 * clock ticks; when the list comes back after a gap, the previous visit's
 * last tick becomes the line New rows are measured against. Opening a
 * thread and coming straight back is one visit, so the badges stay.
 */
export function ListSeen({ listKey }: { listKey: string }) {
  useEffect(() => {
    const key = SEEN_KEY(listKey);
    const read = (): { since: number | null; last: number } => {
      try {
        const v = JSON.parse(localStorage.getItem(key) ?? "null");
        return v && typeof v.last === "number" ? { since: typeof v.since === "number" ? v.since : null, last: v.last } : { since: null, last: 0 };
      } catch {
        return { since: null, last: 0 };
      }
    };
    const write = (v: { since: number | null; last: number }) => {
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* no storage, no badge */
      }
    };
    const now = Date.now();
    const prev = read();
    // Back after a gap: the previous visit's end is the new line.
    const since = prev.last > 0 && now - prev.last > VISIT_GAP_MS ? prev.last : (prev.since ?? (prev.last > 0 ? prev.last : now));
    write({ since, last: now });
    const tick = () => write({ ...read(), last: Date.now() });
    const id = window.setInterval(tick, 15_000);
    window.addEventListener("pagehide", tick);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("pagehide", tick);
      tick();
    };
  }, [listKey]);
  return null;
}
