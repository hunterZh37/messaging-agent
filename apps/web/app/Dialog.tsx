"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { CloseButton } from "./CloseButton";

/**
 * A panel over the page: the scrim, the focus, Escape, and the × in the
 * corner (spec 10a). There is no Cancel button anywhere in this app
 * (operator, 2026-09-10: "We don't want to have a cancel button"), so the ×
 * and Escape are the whole way out.
 *
 * Focus goes into the panel on open and back to whatever opened it on close,
 * because a keyboard should end up where it started. The page underneath does
 * not scroll while this is up: two scrollbars is a mistake the operator has
 * to notice and correct.
 */
export function Dialog({
  title,
  labelledBy,
  onClose,
  returnFocusTo,
  className,
  focus = "input, textarea, button, [href]",
  children,
}: {
  title: string;
  /** The id of the heading this dialog is named by. */
  labelledBy: string;
  onClose: () => void;
  /** The id of the control that opened it, to hand focus back to. */
  returnFocusTo?: string;
  /** An extra class on the panel, for a dialog that is shaped differently. */
  className?: string;
  /**
   * What to focus on open. The default is the first thing that takes focus,
   * which for an editor is its first field. A dialog whose first control is
   * the × in the corner names something better, or Enter would close it.
   */
  focus?: string;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  // The close in the effect below must be the current one without the effect
  // re-running: it is set up once, for one dialog.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusable = panel.current?.querySelector<HTMLElement>(focus);
    (focusable ?? panel.current)?.focus();

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
      }
    }
    document.addEventListener("keydown", onKey);

    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKey);
      // Back to whatever opened this, if it is still on the page.
      if (returnFocusTo) document.getElementById(returnFocusTo)?.focus();
    };
    // The dialog is mounted for one thing at a time; nothing here re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="dialog-scrim" onMouseDown={(event) => event.target === event.currentTarget && close.current()}>
      <div
        className={`dialog-panel${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        ref={panel}
        tabIndex={-1}
      >
        <h2 id={labelledBy} className="dialog-title">
          {title}
        </h2>
        <CloseButton onClick={() => close.current()} label="Close" />
        {children}
      </div>
    </div>
  );
}
