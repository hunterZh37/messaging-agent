"use client";

import { useState } from "react";
import type { DraftView } from "@messaging-agent/core";
import { markupSpans } from "@messaging-agent/core/text";
import { Dialog } from "../Dialog";
import { diffLines } from "@/lib/diff";
import { firstContactLabel } from "@/lib/compose";
import { previewHeader } from "@/lib/preview";
import { DraftAttachmentChips, type CardFile } from "./DraftAttachments";
import { PlainBody } from "./Thread";

/**
 * The last screen before a reply leaves: the mail as the recipient will open
 * it (operator, 2026-09-10: "when I send an edit there should be a pop-up
 * overlay displaying what the preview of the email should look like for the
 * other person"). It replaces the confirm panel that used to open inside the
 * card, which showed the diff and not the mail.
 *
 * Everything here is what will really be sent: the header lines the sender
 * sets, the body as plain text with its links live, and the files going out,
 * each of which can still be opened. What Celeste first wrote is underneath,
 * folded away, because the question at this point is whether the mail is
 * right, not what changed.
 *
 * Send is the only button. Escape and the × in the corner close it (spec
 * 10a); there is no Cancel.
 */
export function SendPreviewDialog({
  view,
  text,
  to,
  cc,
  files,
  firstContact,
  onSend,
  onClose,
  channel = "mail",
}: {
  view: DraftView;
  /** The body as it stands on the card, edits and revisions included. */
  text: string;
  to: string[];
  cc: string[];
  /** The files already on the draft; anything still uploading is not shown. */
  files: CardFile[];
  /**
   * Recipients on a composed draft this account has never written to before
   * (spec 2026-09-22), or null while that is still being asked for. Left out
   * entirely for a reply, which is implicitly safe: the other side wrote
   * first.
   */
  firstContact?: string[] | "unknown" | null;
  onSend: () => void;
  /** Mail, or a text going out through Messages (2026-09-11). */
  channel?: "mail" | "text";
  onClose: () => void;
}) {
  const [showChanges, setShowChanges] = useState(false);
  const header = previewHeader(view, to, cc);
  const edited = text !== view.draft.originalText;
  // A composed message begins a conversation rather than answering one
  // (spec 2026-09-22): the title says so, since there is no reply here to name.
  const composed = view.draft.mode === "new";
  // Send waits for the check on a composed message: an operator who hits
  // Enter the moment the dialog opens must not outrun the one warning that
  // stands between a composed message and a stranger (review, 2026-09-22).
  const checking = composed && firstContact === null;
  const unknown = firstContact === "unknown";
  const warning = firstContactLabel(Array.isArray(firstContact) ? firstContact : []);

  return (
    <Dialog
      title={channel === "text" ? "Send this text" : composed ? "Send this email" : "Send this reply"}
      labelledBy="send-preview-title"
      onClose={onClose}
      className="send-preview"
      // Send takes the focus, so Enter sends. Left to itself the dialog would
      // focus the × in the corner and Enter would close instead.
      focus=".btn.primary"
    >
      <div className="mail-preview">
        <dl className="mail-head">
          <dt>From</dt>
          <dd>{header.from}</dd>
          <dt>To</dt>
          <dd>{header.to}</dd>
          {header.cc !== null && (
            <>
              <dt>Cc</dt>
              <dd>{header.cc}</dd>
            </>
          )}
          <dt>Subject</dt>
          <dd className="mail-subject">{header.subject}</dd>
          <dt>Date</dt>
          <dd>{header.date}</dd>
        </dl>

        {/* A composed message has no thread behind it to vouch for the
            recipient, so the dialog says plainly when this account has never
            written to them before (spec 2026-09-22). A warning, not a block:
            the six-second cancel below is the only gate. */}
        {unknown && (
          <div className="first-contact" role="note">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3l10 18H2z" />
              <path d="M12 9v5" />
              <path d="M12 17h.01" />
            </svg>
            <span>Could not check whether these addresses are new. Read them again before you send.</span>
          </div>
        )}
        {warning && (
          <div className="first-contact" role="note">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3l10 18H2z" />
              <path d="M12 9v5" />
              <path d="M12 17h.01" />
            </svg>
            <span>{warning}</span>
          </div>
        )}

        <div className="mail-body">
          {/* What the reader gets, not what was typed: the marks are drawn
              rather than shown (operator, 2026-09-20). */}
          {markupSpans(text).map((span, i) =>
            span.bold ? (
              <strong key={i}><PlainBody text={span.text} /></strong>
            ) : span.underline ? (
              <u key={i}><PlainBody text={span.text} /></u>
            ) : (
              <PlainBody key={i} text={span.text} />
            ),
          )}
        </div>

        <DraftAttachmentChips draftId={view.draft.id} files={files} showCount />
      </div>

      {edited && (
        <div className="preview-changes">
          <button type="button" className="quoted-toggle" aria-expanded={showChanges} onClick={() => setShowChanges((open) => !open)}>
            {showChanges ? "Hide changes from Celeste's draft" : "Show changes from Celeste's draft"}
          </button>
          {showChanges && (
            <div className="diff">
              {diffLines(view.draft.originalText, text).map((line, i) => (
                <div key={i} className={line.kind}>
                  {line.text || " "}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="row preview-actions">
        <button type="button" className="btn primary" onClick={onSend} disabled={checking}>
          {checking ? "Checking recipients…" : <>Send<kbd>enter</kbd></>}
        </button>
      </div>
    </Dialog>
  );
}
