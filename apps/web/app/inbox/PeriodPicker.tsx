"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { Floating, useAnchoredPanel } from "@/lib/anchored";
import { selectWindowAction } from "../queue/actions";
import type { HeaderChip } from "./HeaderChips";
import { ChevronIcon } from "./icons";

/**
 * The window as a filter (operator, 2026-09-15: "I like top header to feel
 * more like a filter"): a chip saying what the list reaches back over, which
 * opens the four choices. The pick goes through the same action the old chip
 * row used, so it is remembered for the visit exactly as before.
 */
export function PeriodPicker({ chips }: { chips: HeaderChip[] }) {
  const [open, setOpen] = useState(false);
  const [, startTransition] = useTransition();
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const placed = useAnchoredPanel(button, open, 190);
  const current = chips.find((c) => c.on) ?? chips[0]!;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // The panel paints at the end of the page, so it is not inside the chip's
    // box: a press in it would otherwise read as a press outside and shut the
    // panel before the pick landed (2026-09-15 audit).
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

  function pick(event: React.MouseEvent, chip: HeaderChip) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    setOpen(false);
    startTransition(async () => {
      await selectWindowAction(chip.value ?? "today", chip.to);
    });
  }

  return (
    <div className="filter-menu" ref={wrap}>
      <button ref={button} type="button" className="filter-chip period-chip" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="filter-chip-label">Period</span>
        <span className="filter-chip-value">{current.name}</span>
        <ChevronIcon />
      </button>
      {open ? (
        <Floating>
        <div className="switcher-panel filter-panel" role="menu" aria-label="Period" style={placed}>
          {chips.map((chip) => (
            <Link
              key={chip.key}
              href={chip.href}
              role="menuitemradio"
              aria-checked={chip.on}
              className={`switcher-row${chip.on ? " on" : ""}`}
              onClick={(e) => pick(e, chip)}
            >
              <span className="switcher-text">{chip.name}</span>
            </Link>
          ))}
        </div>
        </Floating>
      ) : null}
    </div>
  );
}
