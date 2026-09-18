/** Moves one item of the category or project editor's list, returning a new array. Out-of-range moves are no-ops. */
export function move<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/**
 * Where a dragged row lands, as an index for `move`. Dropping above a row
 * means taking its place; dropping below means the place after it. A row
 * dragged from above the target frees a slot on its way out, which is the
 * `-1`: without it, dragging down always lands one short.
 */
export function dropIndex(from: number, over: number, below: boolean): number {
  const target = below ? over + 1 : over;
  return from < target ? target - 1 : target;
}

/** How long a description may be (core's limit), and when to start saying so. */
export const DESCRIPTION_MAX = 600;
export const DESCRIPTION_WARN = 500;
