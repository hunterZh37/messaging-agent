"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { Floating, useAnchoredPanel, useWide } from "@/lib/anchored";
import { selectProjectAction } from "../queue/actions";
import type { HeaderChip } from "./HeaderChips";
import { ChevronIcon, PencilIcon } from "./icons";

/** One inbox in the sheet: its row, then its projects under it. */
export interface PickerGroup {
  /** Absent for the one inbox the switcher holds, whose projects need no heading. */
  label?: string;
  accountId?: string;
  mail?: number;
  /** Its row narrows the list to this inbox, the way its pill does on desktop. */
  openHref?: string;
  open?: boolean;
  chips: HeaderChip[];
  editHref: string;
}

/** A small folder, marking a group of projects in the sheet. */
function FolderGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

/** The arrow that folds an inbox or a group in the sheet. */
function FoldButton({ open, label, onToggle, nested = false }: { open: boolean; label: string; onToggle: () => void; nested?: boolean }) {
  return (
    <button
      type="button"
      className={`sheet-fold${open ? " open" : ""}${nested ? " nested" : ""}`}
      aria-expanded={open}
      aria-label={`${open ? "Fold" : "Unfold"} ${label}`}
      onClick={onToggle}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 6l6 6-6 6" />
      </svg>
    </button>
  );
}

/** "Consulting · 12" says 12. */
function countOf(chip: HeaderChip): string {
  return chip.label.startsWith(`${chip.name} · `) ? chip.label.slice(chip.name.length + 3) : "";
}

/**
 * The project choice on a phone (operator, 2026-09-15: the project labels had
 * too little room): one button naming what is on, which opens a sheet from
 * the bottom with every inbox and its projects, full names and counts. The
 * sideways strip and pills stay on desktop, where there is room for them.
 * A pick goes through the same action the tabs use, so it is remembered the
 * same way. Only what holds mail in the period on screen is listed (operator,
 * 2026-09-15: "if projects is zero, don't show it"), so nothing in it opens
 * an empty list; the one that is on stays, or it could not be switched off.
 */
export function ProjectPicker(props: {
  allChip: HeaderChip;
  groups: PickerGroup[];
  /** The switcher's inbox, which a pick is remembered under; absent under All inboxes. */
  accountId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [, startTransition] = useTransition();

  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // Desktop: a panel under the chip. Phone: the sheet from the foot of the
  // screen. Either way it paints at the end of the page, since the filter row
  // it sits in fades at its edge and a fade clips what hangs out of it
  // (2026-09-15 audit).
  const wide = useWide();
  const placed = useAnchoredPanel(button, open && wide, 320);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // A press anywhere else shuts it. The sheet paints at the end of the page,
    // so it is not inside the chip's box: a press in it would otherwise shut
    // the sheet before the pick landed (2026-09-15 audit). The veil itself is
    // outside, which is how a press beside the sheet still closes it.
    const onDown = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (wrap.current?.contains(t) || t?.closest?.(".sheet")) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  // What is on: a project, a group, or a project inside a group, named so the
  // button says where in the tree it is (2026-09-15).
  const everyChip = props.groups.flatMap((g) =>
    g.chips.flatMap((chip) => [{ chip, group: g, parent: null as HeaderChip | null }, ...(chip.children ?? []).map((child) => ({ chip: child, group: g, parent: chip }))]),
  );
  const onChip = everyChip.find((x) => x.chip.on && !x.chip.children?.some((c) => c.on) && !(x.chip.group && x.chip.value !== null));
  const openGroup = props.groups.find((g) => g.open);
  const current = onChip
    ? {
        name: onChip.parent ? `${onChip.parent.name} › ${onChip.chip.name}` : onChip.chip.name === "Unfiled" && onChip.group.label ? `${onChip.group.label} · Unfiled` : onChip.chip.name,
        count: countOf(onChip.chip),
      }
    : openGroup?.label
      ? { name: openGroup.label, count: String(openGroup.mail ?? 0) }
      : { name: "All projects", count: countOf(props.allChip) };

  function pick(event: React.MouseEvent, chip: HeaderChip) {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    setOpen(false);
    // The one already on stays on: a picker picks, it does not switch off.
    if (chip.on) return;
    startTransition(async () => {
      await selectProjectAction(props.accountId, chip.value, chip.to);
    });
  }

  const allOn = props.allChip.on;

  // Folded by default, but for the way to what is on (operator, 2026-09-15:
  // "make the inboxes, bigger projects collapsible"). Set each time the
  // sheet opens, so it always opens on the choice.
  const [unfolded, setUnfolded] = useState<Set<string>>(() => new Set());
  const inboxKey = (g: PickerGroup, i: number) => g.accountId ?? `inbox-${i}`;
  function openSheet() {
    const keys = new Set<string>();
    props.groups.forEach((g, i) => {
      const holdsChoice = g.open || g.chips.some((c) => c.on);
      if (!g.label || holdsChoice) keys.add(inboxKey(g, i));
      for (const c of g.chips) if (c.group && c.on) keys.add(c.key);
    });
    setUnfolded(keys);
    setOpen(true);
  }
  function toggle(key: string) {
    setUnfolded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="filter-menu project-menu" ref={wrap}>
      <button ref={button} type="button" className="filter-chip project-picker" aria-haspopup="dialog" aria-expanded={open} onClick={openSheet}>
        <span className="filter-chip-label">Project</span>
        <span className="filter-chip-value project-picker-name">{current.name}</span>
        {current.count ? <span className="project-picker-count">{current.count}</span> : null}
        <ChevronIcon />
      </button>

      {open ? (
        <Floating>
        <div className={wide ? "sheet-veil anchored" : "sheet-veil"} style={wide ? placed : undefined} onClick={() => setOpen(false)}>
          <div className="sheet" role="dialog" aria-modal="true" aria-label="Projects" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <span className="sheet-title">Projects</span>
              <button type="button" className="close-x" aria-label="Close" onClick={() => setOpen(false)}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
            <div className="sheet-body">
              <Link href={props.allChip.href} className={`sheet-row top${allOn && !openGroup ? " on" : ""}`} onClick={(e) => pick(e, { ...props.allChip, on: allOn && !openGroup })}>
                <span className="sheet-name">{props.groups.some((g) => g.label) ? "All inboxes" : "All projects"}</span>
                <span className="sheet-count">{countOf(props.allChip)}</span>
              </Link>
              {props.groups.every((g) => g.chips.length === 0) ? (
                <div className="sheet-empty meta">No projects with mail in this period. Widen the period above.</div>
              ) : null}
              {props.groups.map((g, i) => {
                const inboxOpen = unfolded.has(inboxKey(g, i));
                return (
                <div className="sheet-group" key={g.accountId ?? i}>
                  {g.label ? (
                    <div className="sheet-inbox">
                      <FoldButton open={inboxOpen} label={g.label} onToggle={() => toggle(inboxKey(g, i))} />
                      <Link
                        href={g.openHref ?? props.allChip.href}
                        className={`sheet-row top${g.open && !onChip ? " on" : ""}`}
                        onClick={(e) => {
                          if (g.open && !onChip) e.preventDefault();
                          setOpen(false);
                        }}
                      >
                        <span className="sheet-name">{g.label}</span>
                        <span className="sheet-count">{g.mail ?? 0}</span>
                      </Link>
                      <Link href={g.editHref} className="sheet-edit" aria-label={`Edit ${g.label} projects`} onClick={() => setOpen(false)}>
                        <PencilIcon />
                      </Link>
                    </div>
                  ) : null}
                  {inboxOpen ? g.chips.map((chip) => {
                    // A group is lit as itself only when it, not one of its projects, is the choice.
                    const itself = chip.group ? chip.on && chip.value === null : chip.on;
                    const groupOpen = unfolded.has(chip.key);
                    return (
                      <div key={chip.key} className={chip.group ? "sheet-project-group" : undefined}>
                        <div className="sheet-line">
                          {chip.group ? <FoldButton open={groupOpen} label={chip.name} onToggle={() => toggle(chip.key)} nested /> : null}
                          <Link
                            href={chip.href}
                            className={`sheet-row child${chip.group ? " group" : ""}${itself ? " on" : ""}${chip.dim ? " dim" : ""}`}
                            aria-current={itself ? "true" : undefined}
                            onClick={(e) => pick(e, itself ? { ...chip, on: true } : { ...chip, on: false, value: chip.group ? chip.key : chip.value })}
                          >
                            {chip.group ? <FolderGlyph /> : null}
                            <span className="sheet-name">{chip.name}</span>
                            <span className="sheet-count">{countOf(chip)}</span>
                          </Link>
                        </div>
                        {/* A group's projects, under it once it is unfolded (operator, 2026-09-15). */}
                        {(groupOpen ? (chip.children ?? []) : []).map((child) => (
                          <Link
                            key={child.key}
                            href={child.href}
                            className={`sheet-row grandchild${child.on ? " on" : ""}${child.dim ? " dim" : ""}`}
                            aria-current={child.on ? "true" : undefined}
                            onClick={(e) => pick(e, child.on ? child : { ...child, value: child.key })}
                          >
                            <span className="sheet-name">{child.name}</span>
                            <span className="sheet-count">{countOf(child)}</span>
                          </Link>
                        ))}
                      </div>
                    );
                  }) : null}
                  {!g.label ? (
                    <Link href={g.editHref} className="sheet-row child edit" onClick={() => setOpen(false)}>
                      <PencilIcon />
                      <span className="sheet-name">Edit projects</span>
                    </Link>
                  ) : null}
                </div>
                );
              })}
            </div>
          </div>
        </div>
        </Floating>
      ) : null}
    </div>
  );
}
