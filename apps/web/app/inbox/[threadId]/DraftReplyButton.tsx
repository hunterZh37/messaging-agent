"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CelesteMark } from "../../queue/CelesteMark";
import { draftReplyAction } from "../actions";

/**
 * Runs the drafter for this thread now; the reply card appears under the mail
 * (spec 10a, 2026-09-10), so nothing takes the operator anywhere. A thread the
 * operator spoke last in has nothing to answer, so what they get is a nudge,
 * and the button says so rather than making them find out.
 *
 * When the drafter sees nothing to answer (an automated notice, a receipt),
 * it says so here instead of handing over a "reply" that says it (seen live,
 * 2026-09-11), and "Draft anyway" is the operator's word over hers.
 */
export function DraftReplyButton({ threadId, followUp, text }: { threadId: string; followUp?: boolean; /** A text conversation (2026-09-11). */ text?: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [declined, setDeclined] = useState<string | null>(null);
  const router = useRouter();

  function draft(force: boolean) {
    setError(null);
    startTransition(async () => {
      const r = await draftReplyAction(threadId, { force });
      if (r && "error" in r) return setError(r.error);
      if (r && "declined" in r) return setDeclined(r.declined);
      setDeclined(null);
      // A thread id with anything in it that needs encoding would not match
      // the path the action revalidated, so the page is asked again here.
      router.refresh();
    });
  }

  if (declined) {
    return (
      <>
        <div className="reason draft-declined">
          <CelesteMark />
          <span>{`Nothing to answer here: ${declined}`}</span>
          <button type="button" className="btn quiet" onClick={() => draft(true)} disabled={pending}>
            {pending ? "Celeste is drafting…" : "Draft anyway"}
          </button>
        </div>
        {error ? <div className="error">{error}</div> : null}
      </>
    );
  }

  return (
    <>
      <button type="button" className="btn primary" onClick={() => draft(false)} disabled={pending}>
        {pending ? "Celeste is drafting…" : text ? "Reply with Celeste" : followUp ? "Follow up with Celeste" : "Draft with Celeste"}
      </button>
      {error ? <div className="error">{error}</div> : null}
    </>
  );
}
