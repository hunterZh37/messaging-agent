"use client";

import { useEffect } from "react";

/**
 * A page that threw while rendering. Without this, Next shows its own
 * overlay in development and a blank page in production (stress audit,
 * 2026-09-11). The error is logged where the dev log can see it, and
 * "Try again" re-renders the route, which is what a transient failure (a
 * provider that timed out, a lock held for a moment) needs.
 */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main>
      <div className="empty-wrap">
        <div className="empty-title">Something went wrong on this page.</div>
        <p className="meta" style={{ maxWidth: 480, textAlign: "center", overflowWrap: "anywhere" }}>{error.message}</p>
        <div className="row" style={{ justifyContent: "center" }}>
          <button type="button" className="btn primary" onClick={() => reset()}>
            Try again
          </button>
          <a href="/inbox" className="btn">
            Inbox
          </a>
        </div>
      </div>
    </main>
  );
}
