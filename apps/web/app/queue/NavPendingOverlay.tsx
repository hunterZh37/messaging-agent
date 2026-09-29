"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { navPending, PENDING_AFTER_MS } from "@/lib/navPending";

/**
 * The app saying it is busy (operator, 2026-09-29: "there should be a loading
 * icon popover in the middle while the background is glassy or dark"). The
 * page behind goes soft and a ring turns over the middle of it.
 *
 * It waits out the first fifth of a second. Most pages arrive inside that,
 * and glass thrown over every press would be a flicker to read through rather
 * than an answer — the operator would see it most often on the pages that
 * needed it least.
 *
 * Nothing under it can be pressed while it is up, which is the point: the
 * press already landed, and a second one would only race the first.
 */
export function NavPendingOverlay() {
  // The boolean itself is the snapshot, so the wait below starts when the app
  // becomes busy and not every time a link starts or finishes (review,
  // 2026-09-29).
  const busy = useSyncExternalStore(navPending.subscribe, navPending.busy, () => false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!busy) {
      setShown(false);
      return;
    }
    const timer = window.setTimeout(() => setShown(true), PENDING_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [busy]);

  if (!shown) return null;
  return (
    <div className="nav-loading" role="status" aria-live="polite">
      <span className="nav-loading-ring" aria-hidden="true" />
      <span className="visually-hidden">Loading</span>
    </div>
  );
}
