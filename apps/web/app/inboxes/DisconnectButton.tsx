"use client";

import { useState, useTransition } from "react";
import { disconnectAction } from "./actions";

/** Quiet button with a confirm() dialog. Disconnect drops the stored credentials only — mail and drafts stay. */
export function DisconnectButton({ accountId, email }: { accountId: string; email: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    if (!confirm(`Disconnect ${email}? Stored mail and drafts stay. You can reconnect any time.`)) return;
    startTransition(async () => {
      const r = await disconnectAction(accountId);
      if ("error" in r) setError(r.error);
    });
  }

  return (
    <>
      <button type="button" className="btn quiet" onClick={onClick} disabled={pending}>
        {pending ? "Disconnecting…" : "Disconnect"}
      </button>
      {error ? <div className="error">{error}</div> : null}
    </>
  );
}
