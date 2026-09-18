import type { WindowKey } from "@/lib/selection";

/**
 * Epoch ms the window starts at, or null for "All" (no lower bound).
 * "Today" is local midnight, so it means the day the operator is having.
 * Which window that is comes from `selectedWindow`, which reads the link and
 * then what was remembered (spec 5).
 */
export function windowStart(w: WindowKey, now: number = Date.now()): number | null {
  if (w === "all") return null;
  if (w === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  return now - (w === "7d" ? 7 : 30) * 86_400_000;
}
