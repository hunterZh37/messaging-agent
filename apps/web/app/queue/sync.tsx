"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { relativeTime } from "@/lib/format";
import { afterNetworkLoss, afterPulse, PULSE_MS, PULSE_TIMEOUT_MS, timeoutSignal, UNKNOWN, type Connection, type Fault } from "@/lib/connection";

/** How stale the last sync has to be before opening the app starts another. */
const STALE_MS = 120_000;
// How often the page asks whether anything new was stored, by any sync, and
// reads itself again when so. Three seconds since the chat watcher
// (2026-09-14): a text is in the database a second after it lands, and the
// page should not sit on it for ten more. It lives in lib/connection.ts now,
// beside the deadline one pulse has to beat.

interface SyncState {
  syncing: boolean;
  /** When mail was last pulled, epoch ms; null before the first sync. */
  lastSyncAt: number | null;
  /** Whether anything is getting through. Null until the first pulse answers. */
  online: boolean | null;
  /** Which way it is broken, when it is. */
  fault: Fault | null;
  sync: () => void;
}

const SyncContext = createContext<SyncState>({ syncing: false, lastSyncAt: null, online: null, fault: null, sync: () => {} });

/**
 * One sync at a time, shared by everything that shows it. Wrapped around the
 * whole app so the refresh button spins for the automatic sync too, wherever
 * that button happens to render: the project bar on a folder page or a
 * thread (spec 10d), the top bar everywhere else.
 */
export function SyncProvider(props: { lastSyncAt: number | null; accountCount: number; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [syncing, setSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState(props.lastSyncAt);
  const [conn, setConn] = useState<Connection>(UNKNOWN);
  const { online, fault } = conn;
  const triggered = useRef(false);

  // A fresh server snapshot (after router.refresh) is the truth about when
  // mail was last pulled; the local clock only bridges the gap until it lands.
  useEffect(() => {
    setLastSyncAt(props.lastSyncAt);
  }, [props.lastSyncAt]);

  function sync() {
    setSyncing(true);
    // Through the route, not a server action: a page's actions run one at a
    // time, and a twenty-second sync used to hold every other one back
    // (stress audit, 2026-09-11).
    fetch("/api/sync", { method: "POST" })
      .then((r) => {
        // Only a sync that happened moves the clock. Setting it regardless
        // made the bar say "Synced just now" while the phone was off the
        // tailnet and nothing had been fetched at all.
        if (r.ok) setLastSyncAt(Date.now());
        setConn((c) => afterPulse(c, { ok: r.ok }));
        return r.ok;
      })
      .catch(() => setConn((c) => afterPulse(c, { ok: false })))
      .finally(() => {
        setSyncing(false);
        router.refresh();
      });
  }

  useEffect(() => {
    if (triggered.current) return;
    if (pathname.startsWith("/connecting/")) return; // the connecting page already runs its own sync for this account
    if (props.accountCount === 0) return;
    const stale = props.lastSyncAt === null || Date.now() - props.lastSyncAt > STALE_MS;
    if (!stale) return;

    triggered.current = true;
    sync();
    // Runs once per mount against the server-rendered snapshot; a fresh
    // snapshot arrives via router.refresh() rather than re-running this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live (operator, 2026-09-11): every few seconds a look at whether anything
  // landed; when it did, the page reads itself again, so the tree's counts
  // and the open list move on their own. What brings mail in is the server's
  // own clock since 2026-09-14 (lib/mailClock.ts), not this tab.
  const latest = useRef<number | null>(null);
  useEffect(() => {
    if (props.accountCount === 0) return;
    const visible = () => document.visibilityState === "visible";
    // The pulse already knew when it could not reach the server and said
    // nothing (operator, 2026-09-17: a visual indicator for online or
    // offline). It is the honest signal: not whether the device has wifi,
    // but whether this page can still reach Celeste, which over the tailnet
    // is a different question.
    const drop = () => setConn((c) => afterPulse(c, { ok: false }));
    // One at a time. Without a deadline these used to pile up, and a stack of
    // hung requests answering at once would have thrashed the indicator.
    let inFlight = false;
    const pulse = async () => {
      if (!visible() || inFlight) return;
      inFlight = true;
      try {
        // With a deadline: a phone off the tailnet is not refused by
        // anything, so an unbounded fetch simply waits, and the miss that
        // should have turned the dot red is never recorded (operator,
        // 2026-09-17: the phone still shows green).
        const r = await fetch("/api/pulse", { cache: "no-store", signal: timeoutSignal(PULSE_TIMEOUT_MS) });
        if (!r.ok) {
          drop();
          return;
        }
        const { latest: now, net } = (await r.json()) as { latest: number; net?: boolean };
        setConn((c) => afterPulse(c, { ok: true, net }));
        if (latest.current !== null && now > latest.current) router.refresh();
        latest.current = now;
      } catch {
        drop();
      } finally {
        inFlight = false;
      }
    };
    void pulse();
    const p = window.setInterval(() => void pulse(), PULSE_MS);

    // The browser's own events move the dot at once rather than in three
    // seconds. They are a hint only: a laptop can be on wifi with the tailnet
    // down, which reads as online to the browser and is not, so a claim of
    // being back is never believed until a pulse actually answers.
    const lost = () => setConn(afterNetworkLoss());
    const back = () => void pulse();
    window.addEventListener("offline", lost);
    window.addEventListener("online", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.clearInterval(p);
      window.removeEventListener("offline", lost);
      window.removeEventListener("online", back);
      document.removeEventListener("visibilitychange", back);
    };
    // The route and the sync are stable for the mount; nothing here should restart the clocks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.accountCount]);

  return <SyncContext.Provider value={{ syncing, lastSyncAt, online, fault, sync }}>{props.children}</SyncContext.Provider>;
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

/**
 * The refresh control, with the time of the last sync beside it (operator,
 * 2026-09-09: "a visual indicator to show when the last sync was"). The
 * label re-reads the clock every half minute so "3 min ago" keeps moving;
 * hovering gives the exact time.
 */
export function SyncButton() {
  const { syncing, lastSyncAt, online, fault, sync } = useContext(SyncContext);
  // The clock is read after mount: the server's reading and the browser's
  // differ by a few milliseconds, which is enough to turn "just now" into
  // "1 min ago" between the two renders and have React refuse to hydrate.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  // Offline, "Synced 2 min ago" is true and useless: the question that
  // matters is whether anything is getting through at all, so the dot's
  // answer takes the label rather than sitting next to a stale reassurance.
  const label = online === false
    ? (fault === "no-network" ? "No network" : "Offline")
    : syncing
      ? "Syncing…"
      : lastSyncAt === null
        ? "Not synced yet"
        : now === null
          ? "Synced"
          : `Synced ${relativeTime(lastSyncAt, now)}`;
  const state = online === false ? "off" : online === true ? "on" : "unknown";
  return (
    <span className="sync-status">
      <span
        className={`conn conn-${state}`}
        role="status"
        aria-label={online === false ? (fault === "no-network" ? "No network. Nothing can arrive." : "Offline. Cannot reach Celeste.") : online === true ? "Online" : "Checking the connection"}
        title={
          online === false
            ? fault === "no-network"
              ? "This Mac has no network. Celeste is running, but no mail can arrive and nothing will send."
              : "Cannot reach Celeste. What is on screen may be out of date."
            : online === true
              ? "Connected, and Celeste has a network"
              : "Checking the connection"
        }
      />
      <span className={`sync-label${online === false ? " is-off" : ""}`} title={lastSyncAt === null || now === null ? undefined : new Date(lastSyncAt).toLocaleString()} aria-live="polite">
        {label}
      </span>
      <button type="button" className="btn quiet icon-only refresh-btn" aria-label="Refresh" onClick={sync} disabled={syncing}>
        <span className={syncing ? "spin" : undefined}>
          <RefreshIcon />
        </span>
      </button>
    </span>
  );
}
