"use client";

import { useState } from "react";
import type { DraftView } from "@messaging-agent/core";
import { Dialog } from "../Dialog";
import { diffLines } from "@/lib/diff";
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
  onSend: () => void;
  /** Mail, or a text going out through Messages (2026-09-11). */
  channel?: "mail" | "text";
  onClose: () => void;
}) {
  const [showChanges, setShowChanges] = useState(false);
  const header = previewHeader(view, to, cc);
  const edited = text !== view.draft.originalText;

  return (
    <Dialog
      title={channel === "text" ? "Send this text" : "Send this reply"}
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

        <div className="mail-body">
          <PlainBody text={text} />
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
        <button type="button" className="btn primary" onClick={onSend}>
          Send<kbd>enter</kbd>
        </button>
      </div>
    </Dialog>
  );
}
