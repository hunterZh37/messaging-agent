"use client";

import { useState } from "react";

export function UnlockForm({ next }: { next: string }) {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (pending || passcode === "") return;
    setPending(true);
    setError(null);
    try {
      const r = await fetch("/api/unlock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ passcode }) });
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        setError(body.error ?? "Celeste could not unlock.");
        setPasscode("");
        return;
      }
      // A full load, so every page after this one is read with the session.
      window.location.assign(next);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="unlock-form">
      <label htmlFor="unlock-passcode" className="visually-hidden">Passcode</label>
      <input
        id="unlock-passcode"
        className="field"
        type="password"
        autoComplete="current-password"
        autoFocus
        value={passcode}
        onChange={(e) => setPasscode(e.target.value)}
        placeholder="Passcode"
      />
      <button type="submit" className="btn primary" disabled={pending || passcode === ""}>
        {pending ? "Unlocking…" : "Unlock"}
      </button>
      {error ? <p className="error" role="alert">{error}</p> : null}
    </form>
  );
}
