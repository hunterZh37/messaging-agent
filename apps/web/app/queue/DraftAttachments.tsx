"use client";

import { useState, type ReactNode } from "react";
import { draftAttachmentHref, draftAttachmentSizeLabel, isPreviewable } from "@/lib/attachments";
import { fileKind } from "@/lib/attachments";
import { AttachmentPreview, ClipIcon, DownloadIcon } from "./AttachmentPreview";

/**
 * One file on the card. A chip appears the moment the operator drops it, with
 * `uploading` set and the id the browser made up; the row that comes back
 * from the server replaces it.
 */
export interface CardFile {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  uploading?: boolean;
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/**
 * The files going out with a reply, as chips, with any of them open beneath
 * the row. Clicking a chip of a previewable type opens the file in place;
 * anything else downloads, because nothing else renders safely in this origin
 * (spec 11a). Operator, 2026-09-10: "should be able to click on the PDF and
 * see the content" — the same click works on the card, while editing, and in
 * the send preview.
 *
 * `onRemove` is left out where the file is settled and only being looked at,
 * which is the confirm gate and the preview.
 */
export function DraftAttachmentChips({
  draftId,
  files,
  onRemove,
  showCount = false,
  children,
}: {
  draftId: string;
  files: CardFile[];
  onRemove?: (id: string) => void;
  /** "3 files" ahead of the chips, for the preview, where they read as part of the mail. */
  showCount?: boolean;
  /** The Attach button, on the end of the row where the card wants one. */
  children?: ReactNode;
}) {
  const [previewing, setPreviewing] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setPreviewing((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (files.length === 0 && !children) return null;

  return (
    <>
      <div className="att-row draft-atts">
        {showCount && files.length > 1 && <span className="att-count">{files.length} files</span>}
        {files.map((f) => {
          const shown = previewing.has(f.id);
          const label = (
            <>
              <span className="att-kind">{fileKind(f.filename)}</span>
              <span className="att-name">{f.filename}</span>
              <span className="att-size">{draftAttachmentSizeLabel(f)}</span>
            </>
          );
          return (
            <span key={f.id} className={`chip att-chip${f.uploading ? " dim" : ""}${shown ? " on" : ""}`}>
              {f.uploading ? (
                // Nothing to open yet: the server has not said the file is there.
                <span className="att-open">{label}</span>
              ) : isPreviewable(f.mimeType) ? (
                <button type="button" className="att-open" onClick={() => toggle(f.id)} aria-expanded={shown}>
                  {label}
                </button>
              ) : (
                <a className="att-open" href={draftAttachmentHref(draftId, f.id, true)} download={f.filename}>
                  {label}
                </a>
              )}
              {/* A file that previews had no way to be saved: the chip only
                  opened it, and the preview asks Chrome's viewer for the page
                  without its toolbar (operator, 2026-09-21). */}
              {!f.uploading && (
                <a className="att-dl" href={draftAttachmentHref(draftId, f.id, true)} download={f.filename} aria-label={`Download ${f.filename}`}>
                  <DownloadIcon />
                </a>
              )}
              {onRemove && !f.uploading && (
                <button type="button" className="applied-clear" onClick={() => onRemove(f.id)} aria-label={`Remove ${f.filename}`}>
                  <XIcon />
                </button>
              )}
            </span>
          );
        })}
        {children}
      </div>
      {files
        .filter((f) => previewing.has(f.id) && !f.uploading)
        .map((f) => (
          <AttachmentPreview key={f.id} href={draftAttachmentHref(draftId, f.id, false)} filename={f.filename} mimeType={f.mimeType} />
        ))}
    </>
  );
}
