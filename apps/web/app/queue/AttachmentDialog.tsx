"use client";

import { Dialog } from "../Dialog";
import { formatSize, isPdf } from "@/lib/attachments";
import { DownloadIcon } from "./AttachmentPreview";

/** One attachment, open. The same shape wherever a chip is: mail, draft, or Ask Celeste. */
export interface OpenAttachment {
  /** The bytes to show, served with their own type. */
  href: string;
  /** The same bytes, asked for as a download. */
  downloadHref: string;
  filename: string;
  mimeType: string;
  size?: number;
}

/**
 * An attachment read over the page rather than under its chip (operator,
 * 2026-09-21: "I want to click it and there should be a modal displaying the
 * attachment, but currently the documentations are displayed in-line").
 *
 * Inline, a PDF got whatever height was left in a mail column and the rest of
 * the thread was pushed down the page, so reading a contract meant scrolling
 * a document inside a scrolling thread. Over the page it gets the window, and
 * the thread is where it was when the file closes.
 *
 * The way out is the × and Escape, as everywhere else here; the way to keep
 * it is the one button in the corner, because the PDF is shown without
 * Chrome's own toolbar.
 */
export function AttachmentDialog({ file, onClose }: { file: OpenAttachment; onClose: () => void }) {
  return (
    <Dialog
      title={file.filename}
      labelledBy="att-dialog-title"
      className="att-dialog"
      onClose={onClose}
      // Not the ×, or Enter would shut the file the moment it opened.
      focus=".att-dialog-dl"
    >
      <div className="att-dialog-head">
        <span className="att-size">{file.size === undefined ? "" : formatSize(file.size)}</span>
        <a className="btn att-dialog-dl" href={file.downloadHref} download={file.filename}>
          <DownloadIcon />
          Download
        </a>
      </div>
      <div className="att-dialog-body">
        {isPdf(file.mimeType) ? (
          <iframe src={`${file.href}#toolbar=0`} title={file.filename} />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={file.href} alt={file.filename} />
        )}
      </div>
    </Dialog>
  );
}
