"use client";

import { useEffect, useRef } from "react";

/** How long a chat keeps itself at the bottom while its photos and previews load in. */
const SETTLE_MS = 2500;

/** The nearest ancestor that actually scrolls: the thread pane on desktop, the page on a phone. */
function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  let s = el?.parentElement ?? null;
  while (s && !/(auto|scroll)/.test(getComputedStyle(s).overflowY)) s = s.parentElement;
  return s ?? (document.scrollingElement as HTMLElement | null);
}

/**
 * A chat opens at its bottom (operator, 2026-09-14: "for the message panel,
 * the scrollable should default to be the bottom"): the newest texts and the
 * box to type in. Scrolling the box into view once on mount was not enough:
 * the router scrolled the page after it, and photos loading in pushed the
 * bottom further down. So the pane is pinned to its bottom for a moment
 * after opening, following the content as it grows, and lets go the moment
 * the operator scrolls, taps or types, so "Show earlier" and reading back
 * are never fought.
 */
export function StickToBottom({ threadId }: { threadId: string }) {
  const marker = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const scroller = scrollerOf(marker.current);
    if (!scroller) return;
    let held = true;
    const toBottom = () => {
      if (held) scroller.scrollTop = scroller.scrollHeight;
    };
    const release = () => {
      held = false;
    };
    toBottom();
    const frame = requestAnimationFrame(toBottom);
    const content = scroller === document.scrollingElement ? document.body : (scroller.firstElementChild as HTMLElement | null) ?? scroller;
    const grow = new ResizeObserver(toBottom);
    grow.observe(content);
    const stop = window.setTimeout(() => {
      release();
      grow.disconnect();
    }, SETTLE_MS);
    const target: EventTarget = scroller === document.scrollingElement ? window : scroller;
    for (const ev of ["wheel", "touchstart", "pointerdown", "keydown"]) target.addEventListener(ev, release, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(stop);
      grow.disconnect();
      for (const ev of ["wheel", "touchstart", "pointerdown", "keydown"]) target.removeEventListener(ev, release);
    };
  }, [threadId]);

  return <span ref={marker} hidden />;
}
