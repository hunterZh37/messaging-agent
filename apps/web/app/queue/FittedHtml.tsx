"use client";

import { useEffect, useRef } from "react";

/**
 * A mail's own HTML, scaled to the width it has (operator, 2026-09-20: "fix
 * the email content panel distortion when the right Celeste panel is open").
 *
 * A newsletter is built to a fixed width, usually 600px or more. In a pane
 * 507px wide it overflowed, and although the box scrolls, macOS hides the
 * scrollbar until something moves: the mail simply looked cut in half, with
 * the headline ending mid-word. Opening the Ask panel narrows the pane, so
 * the mail that read correctly a moment ago was suddenly broken.
 *
 * So it is scaled down to fit, the way a phone mail client does, rather than
 * asking the operator to drag a newsletter sideways to read the right half of
 * every line. Only ever down: mail narrower than the pane is left alone.
 */
export function FittedHtml({ html }: { html: string }) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => {
      // Measured unscaled, or each pass would read the last pass's width and
      // the mail would creep smaller every time the pane moved.
      el.style.zoom = "1";
      const room = el.clientWidth;
      const want = el.scrollWidth;
      if (room === 0 || want <= room) return;
      // A floor, because a mail built for a desktop shown at a third of its
      // size is not readable either. Past this it scrolls, as it used to.
      el.style.zoom = `${Math.max(room / want, 0.62)}`;
    };
    fit();
    // The pane changes width when the Ask panel opens, when the window is
    // resized, and when images finish loading and push a table wider.
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    if (el.parentElement) observer.observe(el.parentElement);
    const images = [...el.querySelectorAll("img")].filter((img) => !img.complete);
    for (const img of images) img.addEventListener("load", fit, { once: true });
    return () => {
      observer.disconnect();
      for (const img of images) img.removeEventListener("load", fit);
    };
  }, [html]);

  return <div className="msg-html" ref={box} dangerouslySetInnerHTML={{ __html: html }} />;
}
