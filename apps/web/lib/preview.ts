/**
 * The header block of the send preview: the mail as the person on the other
 * end will open it (operator, 2026-09-10: "there should be a pop-up overlay
 * displaying what the preview of the email should look like for the other
 * person").
 *
 * Every line is what the send will really set. The From is the account the
 * reply goes from, with its display name when it has one, because that is the
 * name in the recipient's list. The subject is the one core worked out for
 * the send (`DraftView.replySubject`), not a guess made here, so the preview
 * cannot drift from the mail. Cc is null rather than empty when there is
 * none, so the row is left out instead of showing a blank.
 *
 * The date is the fixed words "Today, now": a send is seconds away, and a
 * real clock rendered on the server and again in the browser is a hydration
 * mismatch (see app/queue/sync.tsx).
 */
export interface PreviewHeader {
  from: string;
  to: string;
  cc: string | null;
  subject: string;
  date: string;
}

export function previewHeader(
  view: { account: { email: string; displayName: string | null }; replySubject: string },
  to: string[],
  cc: string[],
): PreviewHeader {
  const name = view.account.displayName?.trim();
  return {
    from: name ? `${name} <${view.account.email}>` : view.account.email,
    to: to.join(", ") || "(nobody)",
    cc: cc.length > 0 ? cc.join(", ") : null,
    subject: view.replySubject || "(no subject)",
    date: "Today, now",
  };
}
