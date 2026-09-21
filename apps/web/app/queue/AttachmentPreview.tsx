"use client";

import { isPdf } from "@/lib/attachments";

/** The paperclip, on every attachment chip: inbound in the thread and outgoing on a draft. */
export function ClipIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 11.5l-8.6 8.6a5 5 0 01-7.1-7.1l8.6-8.6a3.3 3.3 0 014.7 4.7l-8.6 8.6a1.7 1.7 0 01-2.4-2.4l7.9-7.9" />
    </svg>
  );
}

/** The arrow on every chip: the way to keep a file, wherever the chip is. */
export function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4v11" />
      <path d="M8 12l4 4 4-4" />
      <path d="M5 19h14" />
    </svg>
  );
}

/**
 * One attachment shown in place, under the chip that opened it: a PDF in an
 * iframe, an image as an image. Only the five allowlisted types ever get
 * here, because the route will not serve anything else with its own MIME type
 * (spec 11a).
 *
 * The same component for mail that arrived and for a file on the way out
 * (operator, 2026-09-10: "should be able to click on the PDF and see the
 * content"), so a file looks the same before it is sent as it will when it
 * lands. `#toolbar=0` asks Chrome's viewer for the page without its chrome.
 */
export function AttachmentPreview({ href, filename, mimeType }: { href: string; filename: string; mimeType: string }) {
  return (
    <div className="att-preview">
      {isPdf(mimeType) ? (
        <iframe src={`${href}#toolbar=0`} title={filename} />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={href} alt={filename} />
      )}
    </div>
  );
}
