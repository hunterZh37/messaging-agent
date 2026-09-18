/**
 * What the open list has already let go of, for the counts that describe it
 * (operator, 2026-09-15: "the Safe to delete number is not in sync with the
 * cards; it has a delay"). A card leaves the moment it is deleted, hidden or
 * handled; the count beside its tree row came from the server and only moves
 * once the provider has finished and the page is read again. So the list says
 * how many of its own rows are gone, and the counts take them off until the
 * fresh page arrives, at which point those rows are no longer in the list and
 * the number taken off is zero again: nothing is ever taken off twice.
 */
export interface ListGone {
  /** Rows gone, the unit the tree counts in. */
  rows: number;
  /** Threads gone, the unit "Delete all" counts in. */
  threads: number;
}

/** How much of a list is gone, given its rows' threads and the threads leaving it. */
export function goneFromList(rowThreadIds: string[], leaving: Iterable<string>): ListGone {
  const out = new Set(leaving);
  const gone = rowThreadIds.filter((id) => out.has(id));
  return { rows: gone.length, threads: new Set(gone).size };
}

/** A count less what has left, never below zero. */
export function lessGone(count: number, gone: number | undefined): number {
  return Math.max(0, count - (gone ?? 0));
}

type Listener = () => void;
const byKey = new Map<string, ListGone>();
const listeners = new Set<Listener>();
let version = 0;

export const listAdjust = {
  set(key: string, gone: ListGone | null): void {
    const prev = byKey.get(key);
    if (!gone || (gone.rows === 0 && gone.threads === 0)) {
      if (!prev) return;
      byKey.delete(key);
    } else {
      if (prev && prev.rows === gone.rows && prev.threads === gone.threads) return;
      byKey.set(key, gone);
    }
    version++;
    for (const l of listeners) l();
  },
  get(key: string): ListGone | undefined {
    return byKey.get(key);
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  version(): number {
    return version;
  },
};
