"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Wants } from "@messaging-agent/core";
import { correctThreadAction } from "./actions";
import { ChevronIcon } from "./icons";

/**
 * "Move this to" on a row (operator, 2026-09-20: "where Jev sorts wrong, I
 * can in the UI tell where that email is supposed to be").
 *
 * The rungs as the operator named them, with the one it is on now marked, so
 * the menu says where the message stands as well as offering to change it.
 *
 * Under a rule, the second half of the ask: "and always from them". A sender
 * rule is read before any model is called, so four Zillow alerts in one
 * morning become one correction rather than four. It is a checkbox and not a
 * separate menu item because it modifies the choice above it rather than
 * being another choice.
 */
const RUNGS: { wants: Wants; name: string; desc: string }[] = [
  { wants: "reply", name: "Reply", desc: "Somebody is waiting on your words" },
  { wants: "action", name: "Action Required", desc: "Something to do, no reply expected" },
  { wants: "knowing", name: "Worth Knowing", desc: "Nothing to do, nobody waiting" },
  { wants: "bin", name: "Safe to Delete", desc: "Never needed again once read" },
];

export function MoveControl({ threadId, subject, wants, senders, onMoving, onFailed, onOpenChange }: {
  threadId: string;
  subject: string;
  /** The rung it is on now, so the menu can mark it. */
  wants?: Wants | null;
  /** Who a standing rule would be about; the menu names them rather than saying "the sender". */
  senders?: string[];
  /** The row slides out before the server answers, the way a delete does. */
  onMoving: () => void;
  /** It comes back if the server refuses, or the row would vanish on a write that never happened. */
  onFailed: (message: string) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [always, setAlways] = useState(false);
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

  function pick(next: Wants) {
    setOpen(false);
    // Moving to the rung it is already on is still worth doing: it stamps the
    // verdict as the operator's, so no re-sort talks them out of it.
    onMoving();
    startTransition(async () => {
      const r = await correctThreadAction(threadId, next, always);
      if ("error" in r) {
        onFailed(r.error);
        return;
      }
      router.refresh();
    });
  }

  const who = senders?.[0];
  return (
    <div className="inbox-row-keep" ref={wrap}>
      <button
        type="button"
        className="keep-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Move the thread ${subject || "(no subject)"}`}
        title="Put this where it belongs"
        onClick={() => setOpen((v) => !v)}
      >
        <span>Move</span>
        <ChevronIcon />
      </button>
      {open ? (
        <div className="keep-menu" role="menu" aria-label="Move this to">
          {RUNGS.map((r) => (
            <button
              key={r.wants}
              type="button"
              role="menuitemradio"
              aria-checked={wants === r.wants}
              className={wants === r.wants ? "keep-row on" : "keep-row"}
              onClick={() => pick(r.wants)}
            >
              <span className="picker-name">
                {r.name}
                {wants === r.wants ? <span className="keep-now"> · where it is now</span> : null}
              </span>
              <span className="picker-desc">{r.desc}</span>
            </button>
          ))}
          {who ? (
            <label className="keep-always">
              <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} />
              <span>
                and always from <b>{who}</b>
                {senders && senders.length > 1 ? ` and ${senders.length - 1} more` : ""}
              </span>
            </label>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
