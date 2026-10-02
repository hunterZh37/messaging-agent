"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Dialog } from "../Dialog";
import { askToSignIn, fixingSignin, signinKey } from "@/lib/signin";

/**
 * An inbox that has stopped letting Celeste in, said out loud (operator,
 * 2026-10-01: "please can you make it more obvious? Make a pop-up and ask me
 * to re-sign into these every single time they happen. Right now they're hard
 * to notice and I was wondering why I had not received any emails from these
 * two inboxes since last").
 *
 * Two of their inboxes had been locked out for two and a half days and the
 * only sign of it was a line of red text on the Drafts page, which is not
 * where anybody looks for it. A mailbox that has quietly stopped arriving is
 * the one failure in this app that hides as silence, so it is worth a panel
 * over the page.
 *
 * It comes back every time Celeste is opened and stays dismissed in between:
 * the operator asked to be told every time it happens, and the thing that
 * matters is that they are told again tomorrow if they put it off today. A
 * panel on every click would stop them reading the inboxes that still work.
 *
 * "Later" holds for this page and no longer. Remembering it in the browser's
 * own storage outlived a reload, which is not what opening Celeste again
 * means (seen in the browser, 2026-10-01). Moving between pages inside the
 * app keeps this mounted, so it stays dismissed while they work.
 */
export function SignInDialog({ emails }: { emails: string[] }) {
  // Not over the page they fix it on: Inboxes is where Reconnect leads, and
  // a panel asking them to go there, there, is just in the way.
  const pathname = usePathname();
  const fixingIt = fixingSignin(pathname);
  const [open, setOpen] = useState(false);
  // Which inboxes they have put off, for as long as this page lives. Held by
  // name rather than as a flag, so another inbox going down asks again.
  const putOff = useRef<string | null>(null);
  const names = signinKey(emails);
  useEffect(() => {
    // `names` rather than `emails` in the deps: the layout hands a fresh array
    // down on every read of the page, and the three-second pulse reads it
    // often — the same inboxes must not ask twice (review, 2026-10-01).
    if (!askToSignIn(emails, putOff.current, pathname)) return;
    setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [names, pathname]);

  function later() {
    putOff.current = names;
    setOpen(false);
  }

  if (!open || fixingIt || emails.length === 0) return null;
  const many = emails.length > 1;
  return (
    // The heading is the dialog's own, the way every other one here does it:
    // a second heading of the same id left the panel with no name for anyone
    // listening to it, which is a poor showing for the one alert meant to be
    // impossible to miss (review, 2026-10-01).
    <Dialog
      title={many ? `${emails.length} inboxes need you to sign in` : "An inbox needs you to sign in"}
      labelledBy="signin-title"
      onClose={later}
      className="signin-dialog"
      focus=".btn.primary"
    >
      <p className="meta">
        {many ? "Nothing has arrived from these since they stopped:" : "Nothing has arrived from this one since it stopped:"}
      </p>
      <ul className="signin-list">
        {emails.map((email) => (
          <li key={email}>{email}</li>
        ))}
      </ul>
      <div className="row">
        <Link href="/inboxes" className="btn primary" onClick={later}>
          Reconnect
        </Link>
        <button type="button" className="btn quiet" onClick={later}>
          Later
        </button>
      </div>
    </Dialog>
  );
}
