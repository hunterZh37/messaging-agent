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

/**
 * The tree row a counted list is drawn as. Hidden stands beside Deleted items
 * rather than under Inbox, so it is the one whose key is not `folder:list`.
 */
export function treeKeyForList(folder: string, list: string): string {
  if (list === "hidden") return "hidden";
  return list === folder ? folder : `${folder}:${list}`;
}

/** What a list on screen has let go of, per tree row, given the threads leaving it. */
export function goneByKey(
  rows: { threadId: string; keys: string[] }[],
  leaving: Iterable<string>,
): Map<string, ListGone> {
  const out = new Set(leaving);
  const seen = new Map<string, { rows: number; threads: Set<string> }>();
  for (const row of rows) {
    if (!out.has(row.threadId)) continue;
    for (const key of row.keys) {
      let found = seen.get(key);
      if (!found) {
        found = { rows: 0, threads: new Set() };
        seen.set(key, found);
      }
      found.rows++;
      found.threads.add(row.threadId);
    }
  }
  return new Map([...seen].map(([key, v]) => [key, { rows: v.rows, threads: v.threads.size }]));
}
