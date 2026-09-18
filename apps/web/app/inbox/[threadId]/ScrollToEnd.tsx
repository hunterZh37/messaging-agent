"use client";

import { useEffect, useRef, useState } from "react";

/** Where the thread ends: the last message, or a chat's box to type in. */
const END_ID = "thread-end";

/** Put where the thread ends. */
export function ThreadEnd() {
  return <span id={END_ID} className="thread-end" aria-hidden="true" />;
}

/** The nearest ancestor that actually scrolls: the thread pane on desktop, the page on a phone. */
function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  let s = el?.parentElement ?? null;
  while (s && !/(auto|scroll)/.test(getComputedStyle(s).overflowY)) s = s.parentElement;
  return s;
}

/** The lowest line of the screen a reader can see: above the phone's fixed action bar, inside the pane. */
function visibleBottom(scroller: HTMLElement | null): number {
  let bottom = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight;
  const bar = document.querySelector(".thread-actions");
  if (bar && getComputedStyle(bar).position === "fixed") bottom = Math.min(bottom, bar.getBoundingClientRect().top);
  return bottom;
}

/**
 * A floating "Scroll to bottom" while the end of a long thread is below the
 * screen (operator, 2026-09-15: "when I first open a message or email if it
 * is a longer thread, there should be a floating button at the bottom").
 * It goes once the end is in view and comes back if the reader scrolls up.
 */
export function ScrollToEnd({ threadId }: { threadId: string }) {
  const self = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    const scroller = scrollerOf(self.current);
    let frame = 0;
    const check = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const end = document.getElementById(END_ID);
        // 24px of slack, so a line or two short of the end does not count as more to read.
        setShow(Boolean(end) && end!.getBoundingClientRect().top > visibleBottom(scroller) + 24);
      });
    };
    check();
    const target: EventTarget = scroller ?? window;
    target.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    // Messages expanding, photos loading and the draft card arriving all move the end.
    const grow = new ResizeObserver(check);
    grow.observe((scroller?.firstElementChild as HTMLElement | null) ?? document.body);
    if (scroller) grow.observe(scroller);
    return () => {
      cancelAnimationFrame(frame);
      target.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
      grow.disconnect();
    };
  }, [threadId]);

  function toEnd() {
    const end = document.getElementById(END_ID);
    if (!end) return;
    const scroller = scrollerOf(self.current);
    const box = scroller ?? document.scrollingElement ?? document.documentElement;
    const from = box.scrollTop;
    const to = from + end.getBoundingClientRect().top - visibleBottom(scroller) + 16;
    // Animated by hand: the browser's own smooth scroll stalled a pixel in
    // on the desktop pane (2026-09-15), and a long mail is a long way to jump.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      box.scrollTop = to;
      return;
    }
    const ms = Math.min(700, 250 + Math.abs(to - from) / 10);
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      box.scrollTop = from + (to - from) * (1 - Math.pow(1 - t, 3));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  return (
    <div ref={self} className="scroll-end">
      {show ? (
        <button type="button" className="scroll-end-btn" onClick={toEnd}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 5v14M6 13l6 6 6-6" />
          </svg>
          Scroll to bottom
        </button>
      ) : null}
    </div>
  );
}
