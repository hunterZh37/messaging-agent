import { channelGlyph } from "@/lib/format";

/** The header's two line icons, shared by the server header and the client bar. */

export function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 20h4l10-10-4-4L4 16v4z" />
      <path d="M14 6l4 4" />
    </svg>
  );
}

/** Points down when the row it opens is shut, and turns when it opens (CSS). */
export function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="chevron">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/** A trash can for Delete (operator, 2026-09-11). */
export function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M6 7l1 13h10l1-13" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

/** A curved arrow back, for Restore out of Deleted items (2026-09-15). */
export function RestoreIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  );
}

/** A crossed eye for Hide (operator, 2026-09-11). */
export function EyeOffIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3l18 18" />
      <path d="M10.6 5.3A10.9 10.9 0 0 1 12 5.2c5 0 8.6 3.6 10 6.8-.5 1.1-1.3 2.3-2.4 3.4" />
      <path d="M6.3 6.5C4.2 7.9 2.8 9.9 2 12c1.4 3.2 5 6.8 10 6.8 1.8 0 3.4-.4 4.8-1.2" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </svg>
  );
}

/**
 * The glyph before the account name in a `.meta` line (operator, 2026-09-11):
 * the Apple mark for a Messages chat, the WhatsApp mark for a WhatsApp one,
 * the envelope for mail. The brand marks are solid shapes, so they fill
 * with the line's colour where the envelope strokes with it; both read at
 * 14px in the muted ink, and neither carries a brand colour.
 */
export function ChannelIcon({ provider }: { provider: string }) {
  switch (channelGlyph(provider)) {
    case "apple":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="glyph-fill">
          <path d="M16.4 12.7c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.8-1.6 0-3.1 1-4 2.4-1.7 3-.4 7.3 1.2 9.7.8 1.2 1.8 2.5 3 2.4 1.2 0 1.7-.8 3.2-.8s1.9.8 3.2.8c1.3 0 2.2-1.2 3-2.4.9-1.3 1.3-2.6 1.3-2.7 0 0-2.6-1-2.6-3.9zM14 5.5c.7-.8 1.1-2 1-3.1-1 0-2.2.7-2.9 1.5-.6.7-1.2 1.9-1 3 1.1.1 2.2-.6 2.9-1.4z" />
        </svg>
      );
    case "whatsapp":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="glyph-fill">
          <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 1.8a8.2 8.2 0 1 1-4.2 15.3l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 0 1 12 3.8zm-3.3 4.3c-.2 0-.5 0-.8.3-.3.3-1 1-1 2.5s1.1 2.9 1.2 3.1c.2.2 2.1 3.2 5.1 4.4 2.5 1 3 .8 3.6.7.5-.1 1.7-.7 2-1.4.2-.7.2-1.3.2-1.4-.1-.1-.3-.2-.6-.3l-2-1c-.3-.1-.5-.2-.7.2-.2.3-.8 1-.9 1.2-.2.2-.3.2-.6.1-.3-.1-1.2-.5-2.4-1.5-.9-.8-1.5-1.8-1.6-2-.2-.3 0-.5.1-.6l.5-.5.3-.5c.1-.2 0-.4 0-.5l-.9-2.2c-.2-.6-.5-.5-.7-.5h-.6z" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M3 7l9 6 9-6" />
        </svg>
      );
  }
}
