"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { connectWhatsappAction } from "./actions";

/** "Connect WhatsApp" (spec 10g, 2026-09-11): chats on this Mac join the Messages folder. */
export function ConnectWhatsapp({ connected }: { connected: boolean }) {
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
            const r = await connectWhatsappAction();
            if ("error" in r) {
              setError(r.error);
              return;
            }
            router.refresh();
          });
        }}
      >
        {pending ? "Reading WhatsApp…" : "Connect WhatsApp"}
      </button>
      {error ? <div className="error">{error}</div> : null}
    </>
  );
}
