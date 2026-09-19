"use client";

import { useEffect, useLayoutEffect, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/**
 * Where a panel opens under the control that owns it, placed in the viewport
 * rather than inside it (operator, 2026-09-15: "the dropdown does not work").
 * The header's filter row scrolls sideways, and a scrolling box clips
 * anything hanging out of it, so the panel is fixed and measured instead.
 */
export function useAnchoredPanel(
  anchor: RefObject<HTMLElement | null>,
  open: boolean,
  width: number,
  /** "above" for a control near the foot of the page, which opens upward. */
  placement: "below" | "above" = "below",
): CSSProperties {
  const [at, setAt] = useState<{ top: number; bottom: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return setAt(null);
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const margin = 8;
      setAt({
        top: r.bottom + 6,
        bottom: window.innerHeight - r.top + 6,
        // Kept on screen: a control at the right edge would otherwise open
        // a panel half of which is past it.
        left: Math.max(margin, Math.min(r.left, window.innerWidth - width - margin)),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, open, width]);
  if (!at) return { visibility: "hidden" };
  return placement === "above"
    ? { position: "fixed", bottom: at.bottom, left: at.left, width }
    : { position: "fixed", top: at.top, left: at.left, width };
}

/**
 * Paints a panel at the end of the page rather than inside the row that owns
 * it: the header's filter row fades at its edge with a mask, and a mask clips
 * everything under it, panel included (2026-09-15).
 */
export function Floating({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  if (!ready) return null;
  return createPortal(children, document.body);
}

/** True while the viewport is desktop-wide, watched so a resize is not missed. */
export function useWide(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const q = window.matchMedia("(min-width: 900px)");
    const read = () => setWide(q.matches);
    read();
    q.addEventListener("change", read);
    return () => q.removeEventListener("change", read);
  }, []);
  return wide;
}
