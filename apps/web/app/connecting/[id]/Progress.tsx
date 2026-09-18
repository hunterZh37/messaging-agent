"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { draftStep, labelStep, sortStep, syncStep } from "../../inboxes/actions";

type Status = "running" | "done" | "error";

/** Runs sync -> sort -> label -> draft for the just-connected account, one line per finished step. No streaming: each step is its own server action awaited in sequence. */
export function Progress({ accountId, email }: { accountId: string; email: string }) {
  const router = useRouter();
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>("running");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLines([]);
    setStatus("running");
    setError(null);

    async function run() {
      const sync = await syncStep(accountId);
      if (cancelled) return;
      if ("error" in sync) {
        setStatus("error");
        setError(sync.error);
        return;
      }
      setLines((l) => [...l, `Fetched ${sync.fetched} message${sync.fetched === 1 ? "" : "s"}`]);

      const sort = await sortStep();
      if (cancelled) return;
      if ("error" in sort) {
        setStatus("error");
        setError(sort.error);
        return;
      }
      setLines((l) => [...l, `Sorted ${sort.sorted}`]);

      const label = await labelStep(accountId);
      if (cancelled) return;
      if ("error" in label) {
        setStatus("error");
        setError(label.error);
        return;
      }
      setLines((l) => [...l, `Labelled ${label.labeled}`]);

      const draft = await draftStep();
      if (cancelled) return;
      if ("error" in draft) {
        setStatus("error");
        setError(draft.error);
        return;
      }
      setLines((l) => [...l, `Drafted ${draft.drafted}`]);

      setStatus("done");
      router.push("/inbox");
    }

    run();
    return () => {
      cancelled = true;
    };
  }, [accountId, attempt, router]);

  return (
    <div className="empty-wrap">
      <div className="empty-title">Connecting {email}</div>
      <div className="card">
        {lines.map((line, i) => (
          <div key={i} className="meta">
            {line}
          </div>
        ))}
        {status === "running" ? <div className="meta">Working…</div> : null}
        {status === "error" && error ? <div className="error">{error}</div> : null}
      </div>
      {status === "error" ? (
        <div className="row">
          <button type="button" className="btn primary" onClick={() => setAttempt((a) => a + 1)}>
            Retry
          </button>
          <Link href="/inboxes" className="btn quiet">
            Accounts
          </Link>
        </div>
      ) : null}
    </div>
  );
}
