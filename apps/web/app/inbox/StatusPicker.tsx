"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Floating, useAnchoredPanel } from "@/lib/anchored";
import { ChevronIcon } from "./icons";

/**
 * The child row in the breadcrumb, as a way of changing it (operator,
 * 2026-09-20: "the word unopened should be clickable and a dropdown should
 * appear"). The tree says the same thing down the side, but the breadcrumb is
 * where the eye already is once the list is open.
 *
 * It says where the operator is and offers the rest of the rungs, All at the
 * top, and nothing else: this picks the child row, and the window, project
 * and inbox come along untouched, the way every other control here behaves.
 */
export function StatusPicker({ label, options }: {
  label: string;
  options: { key: string; name: string; href: string; on: boolean }[];
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const placed = useAnchoredPanel(button, open, 200);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // The panel paints at the end of the page, so a press in it is not a
    // press inside this box: it is asked for by name instead.
    const onDown = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (wrap.current?.contains(t) || t?.closest?.(".switcher-panel")) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  return (
    <div className="head-sub-menu" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="head-sub-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}. Choose another`}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{label}</span>
        <ChevronIcon />
      </button>
      {open ? (
        <Floating>
          <div className="switcher-panel filter-panel" role="menu" aria-label="Which of these" style={placed}>
            {options.map((o) => (
              <Link
                key={o.key}
                href={o.href}
                role="menuitemradio"
                aria-checked={o.on}
                className={`switcher-row${o.on ? " on" : ""}`}
                onClick={() => setOpen(false)}
              >
                <span className="switcher-text">{o.name}</span>
              </Link>
            ))}
          </div>
        </Floating>
      ) : null}
    </div>
  );
}
