"use client";

import Link from "next/link";
import { useTransition } from "react";
import { DEFAULT_WINDOW } from "@/lib/selection";
import { selectFinanceAction, selectProjectAction, selectWindowAction } from "../queue/actions";

export interface HeaderChip {
  key: string;
  /** What it is called, without its count: what a pill repeats when its row is shut. */
  name: string;
  label: string;
  /** Where a plain click goes, so the chips work before hydration too. */
  href: string;
  /** The same page without this dimension, which is where the action redirects. */
  to: string;
  /** What to remember: a value, or null for "no filter on this dimension". */
  value: string | null;
  on: boolean;
  dim?: boolean;
  /** Leads to an empty list, so it is shown in place but not offered. */
  disabled?: boolean;
  /** A group of projects (2026-09-15). */
  group?: boolean;
  /** A group's projects, for the phone's sheet. */
  children?: HeaderChip[];
}

/**
 * One row of controls for one dimension of the view (spec 10a, 10d). Each is
 * a real link, so it reads as one and works before hydration; clicking also
 * writes the choice to its cookie, which is what carries it to the next folder
 * or thread. Every href already holds every other dimension, so a click here
 * changes this one and leaves the rest exactly where they were.
 */
export function HeaderChips(props: {
  kind: "project" | "window" | "finance";
  /** The inbox a project choice belongs to; absent under All inboxes. */
  accountId?: string;
  chips: HeaderChip[];
  /** The look this row wears: a pill by default, an underline tab for projects. */
  className?: "chip" | "tab";
}) {
  const [, startTransition] = useTransition();

  function pick(event: React.MouseEvent, chip: HeaderChip) {
    // A middle click or a modified click means "open this somewhere else",
    // not "change what I am looking at".
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    startTransition(async () => {
      if (props.kind === "window") await selectWindowAction(chip.value ?? DEFAULT_WINDOW, chip.to);
      else if (props.kind === "finance") await selectFinanceAction(chip.value, chip.to);
      // No inbox under All inboxes: the choice is remembered under its own
      // owner there, and the switcher stays where the operator left it.
      else await selectProjectAction(props.accountId, chip.value, chip.to);
    });
  }

  return (
    <>
      {props.chips.map((chip) =>
        chip.disabled ? (
          <span key={chip.key} className={`${props.className ?? "chip"} disabled`} aria-disabled="true" tabIndex={-1}>
            {chip.label}
          </span>
        ) : (
          <Link
          key={chip.key}
          href={chip.href}
          className={`${props.className ?? "chip"}${chip.on ? " on" : ""}${chip.dim ? " dim" : ""}`}
          aria-current={chip.on ? "true" : undefined}
            onClick={(event) => pick(event, chip)}
          >
            {chip.label}
          </Link>
        ),
      )}
    </>
  );
}
