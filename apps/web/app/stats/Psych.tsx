"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { PsychRead } from "@messaging-agent/core";

interface RunState {
  running: boolean;
  done: number;
  total: number;
  axis: string | null;
  error: string | null;
}

function when(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

const VERDICT: Record<string, { label: string; cls: string }> = {
  supported: { label: "your messages agree", cls: "v-for" },
  mixed: { label: "your messages go both ways", cls: "v-mixed" },
  against: { label: "your messages argue against it", cls: "v-against" },
};

/**
 * The psychology section: the type the operator says they are, held up against
 * seven years of their own messages.
 *
 * The type is theirs to declare. Asked to guess one, the same archive gave
 * four different answers depending on how the question was put, so a guessed
 * type was never worth showing. A claim tested against evidence is, and the
 * places the evidence disagrees are the part they cannot get anywhere else,
 * so those are shown at the same size as the agreements rather than tucked
 * away under them.
 */
export function Psych({ read }: { read: PsychRead }) {
  const router = useRouter();
  const [state, setState] = useState<RunState | null>(null);
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState(read.type ?? "INTJ");
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(async (body: object) => {
    setError(null);
    const res = await fetch("/api/psych", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json()) as RunState & { error?: string };
    if (!res.ok) {
      setError(data.error ?? "That did not work");
      return;
    }
    setState(data);
  }, []);

  useEffect(() => {
    if (!state?.running) return;
    const timer = setInterval(async () => {
      const next = (await (await fetch("/api/psych")).json()) as RunState;
      setState(next);
      if (!next.running) router.refresh();
    }, 2000);
    return () => clearInterval(timer);
  }, [state?.running, router]);

  const running = state?.running ?? false;
  const disagrees = read.axes.filter((a) => a.verdict !== "supported").length;

  return (
    <section className="stat-card wide">
      <h2>Psychology</h2>
      <p className="stat-note">
        The type you say you are, held against your own messages. A local model reads a sample of them five times per
        letter and reports where the evidence agrees with you and where it does not. Every message quoted is one you sent.
      </p>

      {read.type === null && !typing ? (
        <p className="tone-empty">No type set yet.</p>
      ) : null}

      {read.type !== null ? (
        <div className="mbti-row">
          <div className="mbti">
            {read.type.split("").map((letter, i) => (
              <span key={`${letter}${i}`} className={`mbti-letter ${read.axes[i]?.verdict === "supported" ? "solid" : "soft"}`}>
                {letter}
              </span>
            ))}
          </div>
          <button type="button" className="chip" onClick={() => setTyping(true)} disabled={running}>
            Change
          </button>
        </div>
      ) : null}

      {typing ? (
        <div className="mbti-set">
          <input
            className="mbti-input"
            value={draft}
            maxLength={4}
            aria-label="Your MBTI type"
            onChange={(e) => setDraft(e.target.value.toUpperCase())}
          />
          <button
            type="button"
            className="btn"
            disabled={busy || draft.length !== 4}
            onClick={async () => {
              setBusy(true);
              await send({ type: draft });
              setBusy(false);
              setTyping(false);
            }}
          >
            Set and test it
          </button>
          <button type="button" className="chip" onClick={() => { setTyping(false); setDraft(read.type ?? "INTJ"); }}>
            Never mind
          </button>
        </div>
      ) : null}

      {read.tested && disagrees > 0 ? (
        <p className="mbti-warn">
          {disagrees === 1 ? "One letter is" : `${disagrees} of the four letters are`} not borne out by how you actually
          write. That disagreement is the useful part; it is set out below.
        </p>
      ) : null}

      <div className="axis-list">
        {read.axes.map((a) => {
          const v = VERDICT[a.verdict] ?? VERDICT.mixed!;
          return (
            <div key={a.axis} className="axis">
              <div className="axis-head">
                <span className="axis-letter">{a.letter}</span>
                <span className="axis-name">
                  {a.name} <span className="axis-vs">not {a.other}</span>
                </span>
                <span className={`axis-firm ${v.cls}`}>
                  {v.label}
                  {a.agreement < a.runs ? ` · ${a.agreement} of ${a.runs} runs` : ""}
                </span>
              </div>
              <p className="axis-why">{a.reasoning}</p>
              {a.supports.length > 0 ? (
                <ul className="axis-ev for">
                  {a.supports.map((e) => (
                    <li key={e.id}>
                      <span className="ev-when">{when(e.sentAt)}</span>
                      <span className="ev-quote">{e.quote}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {a.against.length > 0 ? (
                <>
                  <p className="ev-head">but</p>
                  <ul className="axis-ev against">
                    {a.against.map((e) => (
                      <li key={e.id}>
                        <span className="ev-when">{when(e.sentAt)}</span>
                        <span className="ev-quote">{e.quote}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="tone-actions">
        {running ? (
          <>
            <button type="button" className="btn" onClick={async () => { setBusy(true); await send({ stop: true }); setBusy(false); }} disabled={busy}>
              Stop
            </button>
            <span className="tone-progress">
              Testing {state?.axis ?? "…"} — {state?.done ?? 0} of {state?.total ?? 20}
            </span>
          </>
        ) : read.type !== null && !typing ? (
          <button type="button" className="btn" onClick={async () => { setBusy(true); await send({}); setBusy(false); }} disabled={busy}>
            {read.tested ? "Test it again" : "Test my type"}
          </button>
        ) : null}
      </div>

      {error ?? state?.error ? <p className="tone-error">{error ?? state?.error}</p> : null}
      <p className="tone-caveat">
        MBTI does not reproduce itself: people retaking the questionnaire weeks apart often land on a different type. So
        the letters here are yours, not a finding, and what is worth reading is the evidence under them. Messages also
        only show you with people who already know you: not work, not solitude, not how you are when nobody is writing.
      </p>
    </section>
  );
}
