"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ToneMonthRow } from "@messaging-agent/core";

interface RunState {
  running: boolean;
  done: number;
  total: number;
  month: string | null;
  error: string | null;
  remaining: number;
}

/** "2026-08" → "Aug 2026", which is how a person says a month. */
function label(month: string): string {
  const [y, m] = month.split("-");
  const name = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1] ?? m;
  return `${name} ${y}`;
}

/** Warmth sets the tint of a month in the strip; energy sets how tall it stands. */
const WARMTH_CLASS: Record<string, string> = { guarded: "w-guarded", neutral: "w-neutral", warm: "w-warm" };
const ENERGY_HEIGHT: Record<string, number> = { low: 34, steady: 60, high: 86 };

/**
 * A month worth reading about: the first one, and any where the reading
 * changed from the month before. A list of eighty months that mostly repeat
 * says less than the handful of places something turned.
 */
function shifts(rows: ToneMonthRow[]): ToneMonthRow[] {
  return rows.filter((r, i) => {
    const prev = rows[i - 1];
    return !prev || prev.energy !== r.energy || prev.warmth !== r.warmth;
  });
}

export function Tone({ rows, unread }: { rows: ToneMonthRow[]; unread: number }) {
  const router = useRouter();
  const [state, setState] = useState<RunState | null>(null);
  const [busy, setBusy] = useState(false);

  const send = useCallback(async (body: object) => {
    const res = await fetch("/api/tone", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    setState((await res.json()) as RunState);
  }, []);

  // Poll only while something is running, and read the page again when it
  // stops so the months just read appear without a manual reload.
  useEffect(() => {
    if (!state?.running) return;
    const timer = setInterval(async () => {
      const next = (await (await fetch("/api/tone")).json()) as RunState;
      setState(next);
      if (!next.running) router.refresh();
    }, 2000);
    return () => clearInterval(timer);
  }, [state?.running, router]);

  const running = state?.running ?? false;
  const left = state?.remaining ?? unread;
  const turning = shifts(rows);
  const latest = rows.at(-1);

  return (
    <section className="stat-card wide">
      <h2>How your own writing read</h2>
      <p className="stat-note">
        A local model reads a sample of sixty of your own messages from each month and says how they come across. Your
        messages never leave this Mac, and it is only ever asked about you.
      </p>

      {rows.length === 0 ? (
        <p className="tone-empty">
          Nothing read yet. {unread > 0 ? `${unread} months are waiting, about six seconds each.` : "No months to read."}
        </p>
      ) : (
        <>
          <div className="tone-strip" role="img" aria-label="Every month read, tinted by warmth and sized by energy">
            {rows.map((r) => (
              <span
                key={r.month}
                className={`tone-cell ${WARMTH_CLASS[r.warmth] ?? "w-neutral"}`}
                style={{ height: ENERGY_HEIGHT[r.energy] ?? 60 }}
                title={`${label(r.month)} — ${r.tone} (${r.energy} energy, ${r.warmth})`}
              />
            ))}
          </div>
          <p className="tone-legend">
            <span className="key w-guarded" /> guarded
            <span className="key w-neutral" /> neutral
            <span className="key w-warm" /> warm
            <span className="key-note">taller means more energy</span>
          </p>

          {latest ? (
            <p className="tone-latest">
              <b>{label(latest.month)}</b> reads as <b>{latest.tone}</b>. {latest.note}
            </p>
          ) : null}

          <h3 className="tone-h3">Where it turned</h3>
          <ul className="tone-list">
            {turning.slice(-8).map((r) => (
              <li key={r.month}>
                <span className="tone-month">{label(r.month)}</span>
                <span className="tone-what">
                  <b>{r.tone}</b> · {r.energy} energy · {r.warmth}
                </span>
                <span className="tone-why">{r.note}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="tone-actions">
        {running ? (
          <>
            <button
              type="button"
              className="btn"
              onClick={async () => {
                setBusy(true);
                await send({ stop: true });
                setBusy(false);
              }}
              disabled={busy}
            >
              Stop
            </button>
            <span className="tone-progress">
              Reading {state?.month ? label(state.month) : "…"} — {state?.done ?? 0} of {state?.total ?? 0}
            </span>
          </>
        ) : (
          // Nothing outstanding is a sentence, not a button offering to read
          // nought more months.
          left === 0 && rows.length > 0 ? (
            <span className="tone-progress">Every month has been read.</span>
          ) : (
            <button
              type="button"
              className="btn"
              onClick={async () => {
                setBusy(true);
                await send({});
                setBusy(false);
              }}
              disabled={busy}
            >
              {rows.length === 0 ? "Read my months" : `Read ${left} more`}
            </button>
          )
        )}
      </div>

      {state?.error ? <p className="tone-error">{state.error}</p> : null}
      {rows.length > 0 ? (
        <p className="tone-caveat">
          This is one small model's reading of a sample, not a measurement. It is worth about as much as a friend
          skimming your messages and giving an impression, and it changes if the model does.
        </p>
      ) : null}
    </section>
  );
}
