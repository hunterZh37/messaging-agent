"use client";

/**
 * The two icons every attachment chip wears. The preview that used to live
 * here is now a dialog over the page (operator, 2026-09-21), so what is left
 * is the marks on the chip itself.
 */

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
