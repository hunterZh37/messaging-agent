"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { keepThreadAction } from "./actions";
import { ChevronIcon } from "./icons";
import type { KeepDestination } from "@messaging-agent/core";

/**
 * "Keep" on a Safe-to-delete row (operator, 2026-09-18: "move a mail from
 * Safe to delete"). The × beside it throws the thread away; this is the other
 * answer, and until now there was not one.
 *
 * It asks where, rather than deciding (operator, 2026-09-18): a receipt worth
 * filing and a mail owed an answer both arrive on this list, and they do not
 * want the same thing. Two destinations, because a third would be a settings
 * page.
 *
 * Nothing is re-sorted. This is the operator's word over the sorter's, which
 * is how "No reply needed" and the waiting dismissal already work.
 */
const DESTINATIONS: { dest: KeepDestination; name: string; desc: string }[] = [
  { dest: "inbox", name: "Keep in Inbox", desc: "Off this list, nothing else claimed" },
  { dest: "needs_reply", name: "Need to reply", desc: "You owe an answer on it" },
];

export function KeepControl({ threadId, subject, onKeeping, onFailed, onOpenChange }: {
  threadId: string;
  subject: string;
  /** The row slides out before the server answers, the way a delete does. */
  onKeeping: () => void;
  /** It comes back if the server refuses, or the row would vanish on a write that never happened. */
  onFailed: (message: string) => void;
  /** The row lifts above the ones below it while the menu is down, or they paint over it. */
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [, startTransition] = useTransition();
  const wrap = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: Event) => {
      if (wrap.current?.contains(e.target as HTMLElement | null)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  function pick(dest: KeepDestination) {
    setOpen(false);
    onKeeping();
    startTransition(async () => {
      const r = await keepThreadAction(threadId, dest);
      if ("error" in r) {
        onFailed(r.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="inbox-row-keep" ref={wrap}>
      <button
        type="button"
        className="keep-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Keep the thread ${subject || "(no subject)"}`}
        title="Keep this, it is not safe to delete"
        onClick={() => setOpen((v) => !v)}
      >
        <span>Keep</span>
        <ChevronIcon />
      </button>
      {open ? (
        <div className="keep-menu" role="menu" aria-label="Where to keep it">
          {DESTINATIONS.map((d) => (
            <button key={d.dest} type="button" role="menuitem" className="keep-row" onClick={() => pick(d.dest)}>
              <span className="picker-name">{d.name}</span>
              <span className="picker-desc">{d.desc}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
