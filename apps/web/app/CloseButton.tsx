"use client";

/**
 * The one way out of a panel, dialog or form: an × in its top-right corner
 * (operator, 2026-09-10: "We don't want to have a cancel button"). The
 * parent is positioned; this sits in its corner. Escape does the same thing
 * wherever this appears.
 */
export function CloseButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" className="close-x" onClick={onClick} aria-label={label} title={label}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 6l12 12" />
        <path d="M18 6L6 18" />
      </svg>
    </button>
  );
}
