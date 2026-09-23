"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Dialog } from "../Dialog";

/**
 * The system diagram, over whatever the operator was reading (operator,
 * 2026-09-22: "if I click on architecture, it should display itself in a
 * popover panel").
 *
 * The diagram is an archify page with its own theme, guided views, Present
 * and Export, so it comes in whole, in a frame, rather than being taken apart
 * and drawn again here. /architecture still serves the same page on its own,
 * for a link or a second window.
 *
 * It is mounted only while open: the page behind is 750 KB of diagram, and
 * loading it before anyone asks would cost every screen that carries the
 * sidebar.
 */
export function ArchitectureDialog({ icon, label }: { icon: React.ReactNode; label: string }) {
  const [open, setOpen] = useState(false);
  // The sidebar sits in its own stacking context, so a dialog drawn inside it
  // is trapped under the Ask panel however high its z-index goes. It goes to
  // the body instead, where every other dialog in the app already is.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  /**
   * Escape closes this app's dialogs, and a key pressed inside a frame never
   * reaches the page around it. The diagram is served from this same origin,
   * so the same key can be listened for inside it: without this, the way out
   * stops working the moment the operator clicks the diagram.
   */
  const listenInside = useCallback((frame: HTMLIFrameElement | null) => {
    const doc = frame?.contentDocument;
    if (!doc) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    doc.addEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <button type="button" id="architecture-open" className={open ? "on" : undefined} onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open}>
        {icon}
        <span className="tree-label">{label}</span>
      </button>
      {open && mounted &&
        createPortal(
          <Dialog
            title="Architecture"
            labelledBy="architecture-title"
            onClose={() => setOpen(false)}
            returnFocusTo="architecture-open"
            className="architecture-dialog"
            // The frame, not the × in the corner: the diagram's own keys (the
            // guided views, Present) are then a tab away rather than behind
            // the close button.
            focus=".architecture-frame"
          >
            <iframe
              className="architecture-frame"
              src="/api/architecture"
              title="Celeste system architecture"
              onLoad={(event) => listenInside(event.currentTarget)}
            />
          </Dialog>,
          document.body,
        )}
    </>
  );
}
