"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AlexItem, AlexItemRow, AlexSlot } from "@messaging-agent/core";
import { addToAlexAction, alexFreeTimesAction, retryAlexItemAction } from "../actions";
import { Floating, useAnchoredPanel } from "@/lib/anchored";

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M8 3v4M16 3v4M3 10h18" />
    </svg>
  );
}

const KINDS = [
  { kind: "actionable" as const, label: "Actionable", hint: "A day-scoped item on Alex's calendar. A time is optional." },
  { kind: "event" as const, label: "Event", hint: "A real calendar event, with no attendees. Only for a time already agreed." },
];

/** `2026-09-18T17:00` in the browser's own zone, which is the operator's. */
function localValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dayValue(d: Date): string {
  return localValue(d).slice(0, 10);
}

/** The next round half hour, which is where a timed item starts from. */
function nextHalfHour(): Date {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() > 30 ? 60 : 30);
  return d;
}

/** A `datetime-local` or `date` value as the instant it names here, in ISO. */
function iso(value: string): string {
  return new Date(value).toISOString();
}

function whenLabel(row: AlexItemRow): string {
  const at = new Date(row.whenISO);
  if (Number.isNaN(at.getTime())) return row.whenISO;
  const day = at.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  // An untimed actionable has no clock to show; an event was put somewhere exact.
  if (row.kind === "actionable" && !row.endISO) return day;
  return `${day}, ${at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

/**
 * "Add to Alex" on a thread (spec 10e): an actionable or an event, handed to
 * the scheduling agent over its MCP server. Nothing is written
 * unattended — the operator fills this in and presses Add — and Alex's tools
 * are ordinary code over its database, so no model on either side is talking
 * to the other.
 *
 * Every attempt shows under the button with what Alex said. A refusal keeps
 * its row and a Try again beside it; there is no undo for an actionable,
 * because Alex has no tool to take one back.
 */
export function AddToAlex({ threadId, subject, connected }: { threadId: string; subject: string; connected: boolean }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<AlexItem["kind"]>("actionable");
  const [title, setTitle] = useState("");
  const [day, setDay] = useState(() => dayValue(new Date()));
  const [start, setStart] = useState(() => localValue(nextHalfHour()));
  const [minutes, setMinutes] = useState(30);
  const [timed, setTimed] = useState(false);
  /** What Alex says is free on the chosen day, offered as chips. */
  const [free, setFree] = useState<AlexSlot[] | null>(null);
  const [loadingFree, setLoadingFree] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const router = useRouter();
  // The bar sits at the foot of the thread, so the panel opens upward, and it
  // is painted at the end of the page so no column can paint over it
  // (operator, 2026-09-19).
  const placed = useAnchoredPanel(button, open, 300, "above");

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onDown(e: MouseEvent) {
      // The panel is painted at the end of the page now, so it is no longer
      // inside the wrapper and a press in it would read as a press outside.
      const t = e.target as HTMLElement | null;
      if (wrap.current?.contains(t) || t?.closest?.(".alex-panel")) return;
      setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  // Which day the times are for: the date half of whichever field is in use.
  const onDay = kind === "actionable" && !timed ? day : start.slice(0, 10);
  const wantsTime = kind === "event" || timed;

  // Alex's free slots for that day, re-read when the day, the length or the
  // kind changes. Only while the panel is open and a time is actually wanted.
  useEffect(() => {
    if (!open || !wantsTime || !onDay) return;
    let live = true;
    setLoadingFree(true);
    const from = new Date(`${onDay}T00:00`);
    const to = new Date(`${onDay}T23:59`);
    void alexFreeTimesAction(from.toISOString(), to.toISOString(), minutes).then((r) => {
      if (!live) return;
      setFree(r.slots);
      setLoadingFree(false);
    });
    return () => {
      live = false;
    };
  }, [open, wantsTime, onDay, minutes]);

  function openPanel() {
    // The subject is nearly always what the item is about, so it is the start.
    if (!title) setTitle(subject.slice(0, 80));
    setError(null);
    setOpen(true);
  }

  function build(): AlexItem | string {
    const text = title.trim();
    if (!text) return "Give it a title.";
    const from = new Date(start);
    const to = new Date(from.getTime() + minutes * 60_000);
    if (kind === "event") return { kind: "event", title: text, startISO: from.toISOString(), endISO: to.toISOString() };
    // An actionable is the day it belongs to, and only carries a clock when asked.
    if (!timed) return { kind: "actionable", title: text, dayISO: iso(`${day}T12:00`) };
    return { kind: "actionable", title: text, dayISO: from.toISOString(), startISO: from.toISOString(), endISO: to.toISOString() };
  }

  function add() {
    const item = build();
    if (typeof item === "string") {
      setError(item);
      return;
    }
    setError(null);
    startTransition(async () => {
      const r = await addToAlexAction(threadId, item);
      if ("error" in r) {
        setError(r.error);
        return;
      }
      setOpen(false);
      setTitle("");
      router.refresh();
    });
  }

  const current = KINDS.find((k) => k.kind === kind)!;

  return (
    <div className="add-alex" ref={wrap}>
      <button ref={button} type="button" className="btn quiet" aria-haspopup="dialog" aria-expanded={open} disabled={pending} onClick={() => (open ? setOpen(false) : openPanel())}>
        <CalendarIcon />
        <span>{pending ? "Adding…" : "Add to Alex"}</span>
      </button>

      {open ? (
        <Floating>
        <div className="switcher-panel alex-panel" role="dialog" aria-label="Add to Alex" style={placed}>
          {connected ? null : (
            <div className="error">Alex is not connected. Put ALEX_MCP_TOKEN in .env and restart.</div>
          )}
          <div className="alex-kinds" role="radiogroup" aria-label="Kind">
            {KINDS.map((k) => (
              <button key={k.kind} type="button" role="radio" aria-checked={kind === k.kind} className={`chip${kind === k.kind ? " on" : ""}`} onClick={() => setKind(k.kind)}>
                {k.label}
              </button>
            ))}
          </div>
          <span className="meta">{current.hint}</span>

          <label className="alex-field">
            <span className="meta">Title</span>
            <input className="field" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} autoFocus />
          </label>

          {kind === "actionable" && !timed ? (
            <label className="alex-field">
              <span className="meta">Day</span>
              <input className="field" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
            </label>
          ) : (
            <label className="alex-field">
              <span className="meta">Starts</span>
              <input className="field" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
          )}

          {kind === "event" || timed ? (
            <label className="alex-field">
              <span className="meta">Lasts</span>
              <select className="field" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                {[15, 20, 30, 45, 60, 90].map((m) => (
                  <option key={m} value={m}>{`${m} minutes`}</option>
                ))}
              </select>
            </label>
          ) : null}

          {wantsTime ? (
            <div className="alex-free">
              <span className="meta">
                {loadingFree
                  ? "Reading Alex…"
                  : free === null
                    ? ""
                    : free.length === 0
                      ? "Alex has nothing free on this day. Type any time you like."
                      : "Free in Alex"}
              </span>
              {free && free.length > 0 ? (
                <div className="alex-slots">
                  {free.map((slot) => {
                    const at = new Date(slot.startISO);
                    const value = localValue(at);
                    return (
                      <button
                        key={slot.startISO}
                        type="button"
                        className={`chip${value === start ? " on" : ""}`}
                        onClick={() => setStart(value)}
                      >
                        {at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}

          {kind === "actionable" ? (
            <label className="alex-check">
              <input type="checkbox" checked={timed} onChange={(e) => setTimed(e.target.checked)} />
              <span className="meta">Give it a time</span>
            </label>
          ) : null}

          {error ? <div className="error">{error}</div> : null}

          <div className="row">
            <button type="button" className="btn primary" disabled={pending || !connected} onClick={add}>
              {pending ? "Adding…" : "Add"}
            </button>
          </div>
        </div>
        </Floating>
      ) : null}

    </div>
  );
}

/**
 * What this thread has handed over, under the action row: one line per
 * attempt, so a refusal is on the record with Alex's reason and a way to send
 * it again (spec 10e). There is no undo: Alex has a tool to delete an event
 * but none to take back an actionable, so that one comes out in Alex.
 */
export function AlexItems({ threadId, items }: { threadId: string; items: AlexItemRow[] }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  if (items.length === 0) return null;

  function retry(id: string) {
    startTransition(async () => {
      await retryAlexItemAction(threadId, id);
      router.refresh();
    });
  }

  return (
    <ul className="alex-items" aria-label="Handed to Alex">
      {items.map((row) => (
        <li key={row.id} className={row.status === "failed" ? "failed" : undefined}>
          <span className="alex-item-kind meta">{KINDS.find((k) => k.kind === row.kind)?.label ?? row.kind}</span>
          <span className="alex-item-title">{row.title}</span>
          <span className="meta">{whenLabel(row)}</span>
          {row.status === "failed" ? (
            <>
              <span className="meta alex-item-error">{row.error}</span>
              <button type="button" className="btn quiet" disabled={pending} onClick={() => retry(row.id)}>
                Try again
              </button>
            </>
          ) : (
            <span className="meta">in Alex</span>
          )}
        </li>
      ))}
    </ul>
  );
}
