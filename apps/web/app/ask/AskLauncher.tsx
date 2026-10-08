"use client";

import { useAsk } from "./AskProvider";

/**
 * The way in to Ask Celeste (operator, 2026-10-07: "I want the ask list to be
 * floating at the bottom right corner"). It used to be a row at the foot of
 * the folder tree, which put the way in as far from the panel it opens as the
 * window allows, and buried it under everything else in the sidebar.
 *
 * It hides once the panel is open: a button sitting on top of the thing it
 * opens has nothing left to do, and the panel has its own close.
 */
export function AskLauncher() {
  const { open, toggle } = useAsk();
  if (open) return null;
  return (
    <button type="button" className="ask-launch" aria-label="Ask Celeste" onClick={toggle}>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4L12 3z" />
      </svg>
    </button>
  );
}
