import Link from "next/link";

/**
 * Where a link lands when what it named is gone: a thread deleted from the
 * mailbox itself, an inbox disconnected, a mistyped address. Next's own 404
 * is a black page with a number on it (stress audit, 2026-09-11); this one
 * stays in the app's own voice and hands the operator the way back.
 */
export default function NotFound() {
  return (
    <main>
      <div className="empty-wrap">
        <div className="empty-title">That isn't here any more.</div>
        <p className="meta" style={{ maxWidth: 420, textAlign: "center" }}>
          The thread or page this link named is gone, or was never here. Mail that was deleted from the mailbox itself leaves no page behind.
        </p>
        <div className="row" style={{ justifyContent: "center" }}>
          <Link href="/inbox" className="btn primary">
            Inbox
          </Link>
          <Link href="/" className="btn">
            Drafts
          </Link>
        </div>
      </div>
    </main>
  );
}
