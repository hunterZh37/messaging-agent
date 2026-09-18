"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveAliasesAction } from "./actions";

function RemoveIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/**
 * The operator's other addresses (spec 10a). Mail from one of them is theirs:
 * it sits on their side of a thread, is never sorted, and is never drafted a
 * reply. Saving re-stamps the mail already stored, since the answer for some
 * of it has just changed, and says how much moved.
 */
export function AlsoYou({ addresses }: { addresses: string[] }) {
  const [rows, setRows] = useState(addresses);
  const [adding, setAdding] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();
  const router = useRouter();

  function add() {
    const address = adding.trim();
    if (!address) return;
    setRows(rows.includes(address) ? rows : [...rows, address]);
    setAdding("");
  }

  function save(next: string[]) {
    setError(null);
    setDone(null);
    startSaving(async () => {
      const r = await saveAliasesAction(next);
      if ("error" in r) {
        setError(r.error);
        return;
      }
      setDone(r.restamped === 1 ? "1 message re-stamped" : `${r.restamped} messages re-stamped`);
      router.refresh();
    });
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="who">
        <span>
          <b>Also you</b>
        </span>
      </div>
      <div className="meta">
        <span>Mail from these addresses is treated as yours: right-hand bubbles, never sorted or drafted for.</span>
      </div>

      {rows.map((address) => (
        <div key={address} className="row alias-row">
          <span className="alias-address">{address}</span>
          <button
            type="button"
            className="btn quiet icon-only"
            aria-label={`Remove ${address}`}
            onClick={() => setRows(rows.filter((a) => a !== address))}
          >
            <RemoveIcon />
          </button>
        </div>
      ))}

      <div className="row" style={{ marginTop: 10 }}>
        <input
          className="field"
          value={adding}
          placeholder="another address of yours"
          aria-label="Add an address"
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn quiet" onClick={add} disabled={adding.trim().length === 0}>
          Add
        </button>
        <button type="button" className="btn primary" onClick={() => save(rows)} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        {done ? <span className="meta">{done}</span> : null}
      </div>
      {error ? <div className="error">{error}</div> : null}
    </div>
  );
}
