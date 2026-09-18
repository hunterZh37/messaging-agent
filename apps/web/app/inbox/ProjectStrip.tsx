"use client";

import { useEffect, useRef } from "react";
import { HeaderChips, type HeaderChip } from "./HeaderChips";

/**
 * The project tabs on one line that scrolls sideways (spec 10a). The tab that
 * is on is brought into view on load, because with a long project list it can
 * start off-screen and the operator would see a strip that says nothing about
 * what they are looking at. One strip per row of the bar: one under a chosen
 * inbox, one per inbox under All, where there is no inbox to remember the
 * choice under and `accountId` is absent.
 */
export function ProjectStrip(props: { accountId?: string; chips: HeaderChip[] }) {
  const strip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Only the strip moves, sideways. scrollIntoView would also scroll every
    // scrollable ancestor to line the tab up, which threw the list and thread
    // panes to a random place on each click (operator, 2026-09-10).
    const el = strip.current;
    const on = el?.querySelector<HTMLElement>("[aria-current]");
    if (!el || !on) return;
    const tab = on.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    if (tab.left < box.left) el.scrollLeft += tab.left - box.left - 8;
    else if (tab.right > box.right) el.scrollLeft += tab.right - box.right + 8;
  }, [props.chips]);

  return (
    <div className="tab-strip" ref={strip}>
      <HeaderChips kind="project" accountId={props.accountId} chips={props.chips} className="tab" />
    </div>
  );
}
