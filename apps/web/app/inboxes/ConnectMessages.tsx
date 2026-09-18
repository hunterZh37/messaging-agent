"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { connectImessageAction } from "./actions";

/**
 * "Connect Messages": texts on this Mac join Celeste as their own folder
 * (operator, 2026-09-11). One press; the first sync runs before the page
 * comes back, so the button reads as busy for a few seconds.
 */
export function ConnectMessages({ connected }: { connected: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  if (connected) return null;
  return (
    <>
      <button
        type="button"
        className="btn"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const r = await connectImessageAction();
            if ("error" in r) {
              setError(r.error);
              return;
            }
            router.refresh();
          });
        }}
      >
        {pending ? "Reading Messages…" : "Connect Messages"}
      </button>
      {error ? <div className="error">{error}</div> : null}
    </>
  );
}
