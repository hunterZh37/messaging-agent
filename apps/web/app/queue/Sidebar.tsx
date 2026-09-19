"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { activeTreeKey, rowsForSide, sideHref, sideOfPath, treeRows, type TreeIcon, type TreeSide, type ViewParams } from "@/lib/folders";
import { useAsk } from "../ask/AskProvider";
import { ThemeToggle } from "./ThemeToggle";
import { NotifyToggle } from "./NotifyToggle";
import { useListAdjustVersion } from "./useListAdjust";
import { lessGone, listAdjust } from "@/lib/listAdjust";

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M4 20h4l10-10-4-4L4 16v4z" />
      <path d="M14 6l4 4" />
    </svg>
  );
}

function InboxIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M3 12l3-7h12l3 7v7H3z" />
      <path d="M3 12h5l2 3h4l2-3h5" />
    </svg>
  );
}

function SentIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M21 3L3 10l7 3 3 7 8-17z" />
      <path d="M10 13l4-4" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
    </svg>
  );
}

function JunkIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M12 3l8 3v5c0 4-3.2 7.6-8 10-1.8-.9-3.3-1.9-4.5-3" />
      <path d="M4 11V6l4-1.5" />
      <path d="M3 3l18 18" />
    </svg>
  );
}

function InboxesIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

/** The Celeste mark, as a sidebar glyph: filled, unlike every stroked icon here. */
function AskIcon() {
  return (
    <svg viewBox="0 0 24 24" className="ask-glyph">
      <path d="M12 2l2.4 7.6L22 12l-7.6 2.4L12 22l-2.4-7.6L2 12l7.6-2.4z" />
    </svg>
  );
}

/** A small bar chart: what the Usage page is, as a glyph. */
/** A clock face: the stats page is mostly about when, and how long. */
function StatsIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  );
}

function UsageIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M4 20V10M10 20V5M16 20v-7M22 20H2" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

function BubbleIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-4 4v-4H6a2 2 0 0 1-2-2z" />
    </svg>
  );
}

/** An eye with a stroke through it: the same glyph the Hide button carries. */
function HiddenIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M3 3l18 18" />
      <path d="M10.6 5.2A9.7 9.7 0 0 1 12 5c5 0 9 4.5 9 7a12 12 0 0 1-2.3 3.4" />
      <path d="M6.4 6.5A12.6 12.6 0 0 0 3 12c0 2.5 4 7 9 7a9.6 9.6 0 0 0 4-.9" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </svg>
  );
}

const GLYPHS: Record<TreeIcon, () => ReactNode> = {
  drafts: PencilIcon,
  inbox: InboxIcon,
  sent: SentIcon,
  deleted: TrashIcon,
  junk: JunkIcon,
  messages: BubbleIcon,
  hidden: HiddenIcon,
};

/** The counts the tree shows beside Drafts, Need to reply and Waiting for reply. */
export interface TreeCounts {
  /** Everything the Inbox list itself holds (operator, 2026-09-18). */
  inbox: number;
  drafts: number;
  needsReply: number;
  /** Inbox threads holding something the operator has not opened (spec 10a). */
  unopened: number;
  /** Inbox mail the sorter says nobody will need again (spec 7, 2026-09-11). */
  disposable: number;
  waiting: number;
  /** Conversations hidden until the other side writes again (2026-09-16). */
  hidden?: number;
  /** The rows under Messages (2026-09-11); absent when no Messages account is connected. */
  texts?: { needsReply: number; unopened: number; disposable: number; hidden?: number };
}

/** How long the switch's pill takes to travel and settle. */
const SWITCH_MS = 480;

/**
 * The last switch, so a toggle that mounts with the new page carries on the
 * slide its predecessor started rather than jumping to the end: Mail and
 * Messages are different pages, and the page can land mid-slide.
 */
let lastSwitch: { to: TreeSide; at: number } | null = null;

/**
 * The pill's flight, as a fraction of its own width plus the 2px gap: one
 * continuous glide that overshoots a touch and settles (operator,
 * 2026-09-15: "a satisfying animation for the switcher").
 */
function slideFrames(to: TreeSide): Keyframe[] {
  const at = (pct: number) => `translateX(calc(${pct}% + ${(pct / 100) * 2}px))`;
  const [a, b] = to === "messages" ? [0, 100] : [100, 0];
  const lerp = (t: number) => a + (b - a) * t;
  return [
    { offset: 0, transform: at(lerp(0)), easing: "cubic-bezier(0.22, 0.85, 0.32, 1)" },
    { offset: 0.62, transform: at(lerp(1.05)), easing: "cubic-bezier(0.45, 0, 0.35, 1)" },
    { offset: 1, transform: at(lerp(1)) },
  ];
}

/** The stretch on top of the glide: long while it travels, squashed as it lands, then itself again. */
const STRETCH_FRAMES: Keyframe[] = [
  { offset: 0, transform: "scaleX(1)", easing: "ease-out" },
  { offset: 0.28, transform: "scaleX(1.14)", easing: "ease-in-out" },
  { offset: 0.62, transform: "scaleX(0.95)", easing: "ease-in-out" },
  { offset: 0.82, transform: "scaleX(1.015)", easing: "ease-out" },
  { offset: 1, transform: "scaleX(1)" },
];

/**
 * Mail or Messages, top left (operator, 2026-09-14). Each side says how much
 * of it has not been opened, so the other side is never out of mind. One pill
 * slides under the two words (2026-09-15).
 */
function SideToggle(props: { side: TreeSide; counts: TreeCounts; params: ViewParams; onPick: (side: TreeSide) => void }) {
  const thumb = useRef<HTMLSpanElement>(null);
  // Before paint, so the pill never shows a frame in the wrong place. Only a
  // tap sets it moving: a page that opens on Messages, or a side restored
  // from the browser, just shows the pill where it belongs.
  useLayoutEffect(() => {
    const el = thumb.current;
    if (!el || typeof el.animate !== "function" || !lastSwitch || lastSwitch.to !== props.side) return;
    const elapsed = performance.now() - lastSwitch.at;
    if (elapsed >= SWITCH_MS || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const slide = el.animate(slideFrames(props.side), { duration: SWITCH_MS });
    const stretch = el.animate(STRETCH_FRAMES, { duration: SWITCH_MS, composite: "add" });
    slide.currentTime = elapsed;
    stretch.currentTime = elapsed;
    return () => {
      slide.cancel();
      stretch.cancel();
    };
  }, [props.side]);

  // Words only: in a 220px column an icon and a count left "Mess…" (2026-09-14).
  // What has not been opened, not what owes a reply (operator, 2026-09-15:
  // "the 1 on Messages should be gone if I open up the message"): a badge is
  // read as unread, and one that outlives the opening never goes away by
  // being looked at. What owes a reply is the tree's Need to reply row.
  const sides: { side: TreeSide; label: string; count: number }[] = [
    { side: "mail", label: "Mail", count: props.counts.unopened },
    { side: "messages", label: "Messages", count: props.counts.texts?.unopened ?? 0 },
  ];
  return (
    <div className="side-toggle" role="tablist" aria-label="Mail or Messages" data-side={props.side}>
      <span ref={thumb} className="side-toggle-thumb" aria-hidden="true" />
      {sides.map(({ side, label, count }) => {
        const on = props.side === side;
        return (
          <Link
            key={side}
            href={sideHref(side, props.params, props.counts.texts)}
            role="tab"
            aria-selected={on}
            className={on ? "on" : undefined}
            onClick={() => {
              if (side !== props.side) lastSwitch = { to: side, at: performance.now() };
              props.onPick(side);
            }}
            title={count > 0 ? `${label}: ${count} unopened` : label}
          >
            <span className="side-toggle-label">{label}</span>
            {count > 0 ? <span className="side-toggle-count">{count}</span> : null}
          </Link>
        );
      })}
    </div>
  );
}

const SIDE_KEY = "celeste-side";

/** Until when a menu that opens should stay open: set by a Mail / Messages switch made while the phone menu is open (2026-09-15). */
let keepMenuOpenUntil = 0;

function Tree(props: { counts: TreeCounts; activeKey: string; params: ViewParams; side: TreeSide }) {
  useListAdjustVersion();
  return (
    <div className="tree">
      {rowsForSide(treeRows(props.counts, props.params), props.side).map((row) => {
        const Glyph = row.icon ? GLYPHS[row.icon] : null;
        const on = row.key === props.activeKey;
        return (
          <Link
            key={row.key}
            href={row.href}
            className={[row.child ? "child" : "", on ? "on" : ""].filter(Boolean).join(" ") || undefined}
            aria-current={on ? "page" : undefined}
          >
            {Glyph ? <Glyph /> : null}
            <span className="tree-label">{row.label}</span>
            {row.counted ? <span className="tree-count">{lessGone(row.count, listAdjust.get(row.key)?.rows)}</span> : null}
          </Link>
        );
      })}
    </div>
  );
}

/**
 * The folder tree (spec 10a): a 220px labelled sidebar on desktop, a drawer
 * behind a menu button on phones. The inbox switcher now leads the header's
 * filters instead of sitting here (operator, 2026-09-15). `params` is the view the operator is
 * in, which every row carries, so picking a folder or a child row changes
 * that and leaves the window, the money side and the project alone.
 */
export function Nav(props: { counts: TreeCounts; params?: ViewParams }) {
  const pathname = usePathname() ?? "/";
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const ask = useAsk();

  const activeKey = activeTreeKey(pathname, {
    folder: params?.get("folder") ?? undefined,
    status: params?.get("status") ?? undefined,
  });
  const inboxesOn = activeKey === "inboxes";
  const usageOn = pathname.startsWith("/usage");
  const statsOn = pathname.startsWith("/stats");

  // The side the page is on, or on a page that is neither, the side last
  // chosen. Remembered in the browser; a page read on the server starts on
  // Mail and moves over once the browser says otherwise.
  const pathSide = sideOfPath(pathname, params?.get("folder") ?? undefined);
  const [chosen, setChosen] = useState<TreeSide>("mail");
  // The side just tapped, shown before its page arrives (operator,
  // 2026-09-15: "the switch between the two is not snappy"): the toggle and
  // the tree move on the tap, and the list dims until the page lands.
  const [pendingSide, setPendingSide] = useState<TreeSide | null>(null);
  useEffect(() => {
    if (pathSide) {
      setChosen(pathSide);
      try {
        window.localStorage.setItem(SIDE_KEY, pathSide);
      } catch {
        /* storage off: the page still says which side it is on */
      }
      return;
    }
    try {
      const stored = window.localStorage.getItem(SIDE_KEY);
      if (stored === "mail" || stored === "messages") setChosen(stored);
    } catch {
      /* storage off */
    }
  }, [pathSide]);
  const side: TreeSide = pendingSide ?? pathSide ?? chosen;

  // A page has arrived, this one on mount or a new path: nothing is pending.
  useEffect(() => {
    setPendingSide(null);
    delete document.documentElement.dataset.switching;
  }, [pathname]);

  function pickSide(picked: TreeSide) {
    setChosen(picked);
    if (picked === side) return;
    setPendingSide(picked);
    document.documentElement.dataset.switching = "1";
    // The menu stays open across the switch when it was open for it.
    if (open) keepMenuOpenUntil = Date.now() + 3000;
    // A switch that never lands (offline, an error) does not leave the list dim.
    window.setTimeout(() => {
      delete document.documentElement.dataset.switching;
    }, 8000);
  }
  const hasTexts = props.counts.texts !== undefined;

  // Navigating closes the drawer: the operator asked for that page, not for
  // the menu to stay over it.
  // Switching Mail and Messages from inside the menu keeps the menu open
  // (operator, 2026-09-15): that tap picks which folders to look at, not a
  // page to go to. Any other navigation closes it.
  // Mail and Messages are different pages, each with its own menu, so the
  // menu the switch lands on starts closed: it reopens itself when the switch
  // was made from inside the menu a moment ago. A moment rather than a flag,
  // because the switch can arrive as more than one change of path and params.
  useEffect(() => {
    if (Date.now() >= keepMenuOpenUntil) return;
    setOpen(true);
    // Landed: the next tap on a folder closes the menu as it always has.
    const settle = window.setTimeout(() => {
      keepMenuOpenUntil = 0;
    }, 800);
    return () => window.clearTimeout(settle);
  }, []);
  useEffect(() => {
    if (Date.now() < keepMenuOpenUntil) return;
    setOpen(false);
  }, [pathname, params]);

  useEffect(() => {
    if (!open) return;
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // `inDrawer`: the phone's menu, which has no Mail / Messages switch of its
  // own (operator, 2026-09-15: "only keep the one from the header"). The
  // desktop sidebar keeps it, having no header bar to hold one.
  const content = (inDrawer: boolean) => (
    <>
      {hasTexts && !inDrawer ? <SideToggle side={side} counts={props.counts} params={props.params ?? {}} onPick={pickSide} /> : null}
      <Tree counts={props.counts} activeKey={activeKey} params={props.params ?? {}} side={hasTexts ? side : "mail"} />
      <div className="tree-spacer" />
      <div className="side-bottom">
        <button type="button" className={`ask-row${ask.open ? " on" : ""}`} onClick={ask.toggle} aria-pressed={ask.open}>
          <AskIcon />
          <span className="tree-label">Ask Celeste</span>
          <kbd className="ask-kbd">⌘/</kbd>
        </button>
        <Link href="/inboxes" className={inboxesOn ? "on" : undefined} aria-current={inboxesOn ? "page" : undefined}>
          <InboxesIcon />
          <span className="tree-label">Inboxes</span>
        </Link>
        {/* How the operator messages: a mirror, not a to-do list (2026-09-17). */}
        <Link href="/stats" className={statsOn ? "on" : undefined} aria-current={statsOn ? "page" : undefined}>
          <StatsIcon />
          <span className="tree-label">Stats</span>
        </Link>
        {/* What the models have cost, beside where they are named (spec 13, 2026-09-11). */}
        <Link href="/usage" className={usageOn ? "on" : undefined} aria-current={usageOn ? "page" : undefined}>
          <UsageIcon />
          <span className="tree-label">Usage</span>
        </Link>
        <NotifyToggle />
        <ThemeToggle withLabel />
      </div>
    </>
  );

  return (
    <>
      <div className="switchbar">
        <button
          type="button"
          className="menu-btn"
          aria-label="Menu"
          aria-controls="folder-drawer"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <MenuIcon />
        </button>
        {/* On a phone the top bar carries Mail or Messages, a tap from
            anywhere (2026-09-14); the inbox switcher lives in the menu. */}
        {hasTexts ? <SideToggle side={side} counts={props.counts} params={props.params ?? {}} onPick={pickSide} /> : null}
        {/* The phone top bar's way to Celeste: the sidebar's row is behind
            the menu, and a phone has no ⌘/ (the phone pass, 2026-09-11). */}
        <button type="button" className={`ask-topbtn${ask.open ? " on" : ""}`} onClick={ask.toggle} aria-pressed={ask.open} aria-label="Ask Celeste">
          <AskIcon />
        </button>
      </div>
      {open ? <div className="drawer-overlay" onClick={() => setOpen(false)} /> : null}
      {open ? (
        <nav id="folder-drawer" className="drawer" aria-label="Folders">
          {content(true)}
        </nav>
      ) : null}
      <nav className="side" aria-label="Primary">
        {content(false)}
      </nav>
    </>
  );
}
