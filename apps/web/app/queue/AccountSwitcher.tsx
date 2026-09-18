"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Floating, useAnchoredPanel } from "@/lib/anchored";
import { accountLabels } from "@/lib/selection";
import { selectAccountAction } from "./actions";

export interface SwitcherAccount {
  id: string;
  email: string;
  status: "ok" | "needs_signin" | "disconnected";
}

function TraysGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="4" width="13" height="10" rx="2" />
      <rect x="7" y="10" width="13" height="10" rx="2" />
    </svg>
  );
}

function ChevronGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="switcher-chev">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/**
 * The one control that says which inbox every surface shows (spec 10a): All,
 * or one connected inbox. The choice is a cookie, so it survives the visit;
 * a link carrying `?account=` overrides it while that link is open.
 */
export function AccountSwitcher(props: { accounts: SwitcherAccount[]; selectedId: string | undefined }) {
  const connected = props.accounts.filter((a) => a.status !== "disconnected");
  const labels = accountLabels(connected);
  const selected = connected.find((a) => a.id === props.selectedId) ?? null;
  const label = selected ? (labels[selected.id] ?? selected.email) : "All inboxes";

  const [open, setOpen] = useState(false);
  const [, startTransition] = useTransition();
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const placed = useAnchoredPanel(button, open, 260);
  const pathname = usePathname();
  const params = useSearchParams();

  // Where the action sends the operator back to: this page, minus `account=`
  // (the cookie now holds the choice), keeping filter, window, and category.
  function target(): string {
    const next = new URLSearchParams(params?.toString() ?? "");
    next.delete("account");
    // An open inbox pill belongs to the All-inboxes bar; a switch of inbox
    // lets it go rather than carrying it along and back (2026-09-11).
    next.delete("inbox");
    const query = next.toString();
    return query ? `${pathname}?${query}` : pathname;
  }

  useEffect(() => {
    if (!open) return;
    function onDown(ev: Event) {
      // The panel is painted at the end of the page, outside this box
      // (2026-09-15 audit): a press in it is not a press outside.
      const t = ev.target as HTMLElement | null;
      if (box.current?.contains(t) || t?.closest?.(".switcher-panel")) return;
      setOpen(false);
    }
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Opening lands on the row that is checked, so the keyboard starts where the eye does.
  useEffect(() => {
    if (!open) return;
    const rows = panel.current?.querySelectorAll<HTMLElement>("[data-row]");
    if (!rows || rows.length === 0) return;
    const checked = [...rows].find((r) => r.getAttribute("aria-checked") === "true");
    (checked ?? rows[0]!).focus();
  }, [open]);

  function moveFocus(ev: React.KeyboardEvent<HTMLDivElement>) {
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
    const rows = [...(panel.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [])];
    if (rows.length === 0) return;
    ev.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const step = ev.key === "ArrowDown" ? 1 : -1;
    rows[(at + step + rows.length) % rows.length]!.focus();
  }

  function choose(id: string | null) {
    setOpen(false);
    const to = target();
    startTransition(async () => {
      await selectAccountAction(id, to);
    });
  }

  return (
    <div className="switcher" ref={box}>
      <button
        ref={button}
        type="button"
        className="switcher-btn filter-chip"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Inbox: ${label}`}
        onClick={() => setOpen((v) => !v)}
      >
        {/* In the header beside Period and Project, it says what it filters
            (operator, 2026-09-15: the switcher moved out of the sidebar). */}
        <span className="filter-chip-label">Inbox</span>
        <span className="switcher-btn-label filter-chip-value">{label}</span>
        <ChevronGlyph />
      </button>
      {open ? (
        <Floating>
        <div className="switcher-panel" role="menu" aria-label="Inbox" ref={panel} style={placed} onKeyDown={moveFocus}>
          <button
            type="button"
            data-row
            role="menuitemradio"
            aria-checked={selected === null}
            className="switcher-row"
            onClick={() => choose(null)}
          >
            <span className="switcher-glyph">
              <TraysGlyph />
            </span>
            <span className="switcher-text">
              <span className="switcher-label">All inboxes</span>
            </span>
          </button>
          {connected.map((a) => {
            const rowLabel = labels[a.id] ?? a.email;
            return (
              <button
                key={a.id}
                type="button"
                data-row
                role="menuitemradio"
                aria-checked={selected?.id === a.id}
                className="switcher-row"
                onClick={() => choose(a.id)}
              >
                <span
                  className={`switcher-dot${a.status === "needs_signin" ? " warn" : ""}`}
                  role="img"
                  aria-label={a.status === "needs_signin" ? "needs sign-in" : "synced"}
                />
                <span className="switcher-text">
                  <span className="switcher-label">{rowLabel}</span>
                  {rowLabel === a.email ? null : <span className="switcher-sub">{a.email}</span>}
                </span>
              </button>
            );
          })}
          <Link href="/inboxes" data-row role="menuitem" className="switcher-row add" onClick={() => setOpen(false)}>
            <span className="switcher-glyph" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </span>
            <span className="switcher-text">
              <span className="switcher-label">Add inbox…</span>
            </span>
          </Link>
        </div>
        </Floating>
      ) : null}
    </div>
  );
}
