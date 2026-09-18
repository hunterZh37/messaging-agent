"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";

/**
 * Where each list was scrolled to, by the view it shows: the row at the top
 * of the pane and how far above the pane's edge it sat. Module state rather
 * than component state because the list is a new element on every thread
 * opened: the page under a thread is its own route, so React builds the
 * list again and the browser starts it at the top (operator, 2026-09-11:
 * "when I click on an email, the scrollable jumps around").
 *
 * A row rather than a pixel offset, because a sync can put new mail above
 * while the operator reads: the same pixel then shows different rows, and
 * the list looks as if it jumped.
 */
const anchors = new Map<string, { threadId: string; offset: number }>();

function rowsOf(pane: HTMLElement): HTMLElement[] {
  return [...pane.querySelectorAll<HTMLElement>(".inbox-row[data-thread-id]")];
}

/** Where a row's top edge sits, measured from the pane's top edge, as drawn. */
function topOf(pane: HTMLElement, row: HTMLElement): number {
  // Measured on screen rather than through offsetTop: a row's offsetTop is
  // relative to its own positioned wrapper, not to the pane.
  return row.getBoundingClientRect().top - pane.getBoundingClientRect().top;
}

/** The first row still showing, and how far above the top edge it starts. */
function anchorOf(pane: HTMLElement): { threadId: string; offset: number } | null {
  for (const row of rowsOf(pane)) {
    const top = topOf(pane, row);
    if (top + row.offsetHeight > 0) return { threadId: row.dataset.threadId!, offset: top };
  }
  return null;
}

/**
 * The scrolling pane the rows sit in. It comes back to where it was for the
 * same view, and then, only if the open thread's row is out of sight, moves
 * the least it can to show it: a run of deletes walks the selection down the
 * list, and the list should follow without leaping.
 */
export function ListScroll({ scrollKey, className, children }: { scrollKey: string; className: string; children: ReactNode }) {
  const pane = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = pane.current;
    if (!el) return;
    const kept = anchors.get(scrollKey);
    if (kept) {
      const row = rowsOf(el).find((r) => r.dataset.threadId === kept.threadId);
      if (row) el.scrollTop += topOf(el, row) - kept.offset;
    }
    const selected = el.querySelector<HTMLElement>(".inbox-row.selected");
    if (selected) {
      const top = topOf(el, selected);
      const bottom = top + selected.offsetHeight;
      if (top < 0 || bottom > el.clientHeight) {
        selected.scrollIntoView({ block: "nearest" });
        const a = anchorOf(el);
        if (a) anchors.set(scrollKey, a);
      }
    }
  }, [scrollKey]);

  return (
    <div
      ref={pane}
      className={className}
      onScroll={(e) => {
        const a = anchorOf(e.currentTarget);
        if (a) anchors.set(scrollKey, a);
      }}
    >
      {children}
    </div>
  );
}
