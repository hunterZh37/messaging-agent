import type { ReactNode } from "react";

/**
 * A section that is on the page but not in the way (operator, 2026-09-19:
 * "information overload the stats page").
 *
 * Twelve sections down one scroll meant the first screen shouted everything
 * at once and the numbers that change behaviour sat level with the ones that
 * are merely interesting. Nothing is deleted here. The quieter sections keep
 * their place in the order and wait behind a line that says what is inside,
 * so a closed fold still answers "is there anything in there for me".
 *
 * Native `details`, so it works before the JavaScript arrives, opens to a
 * find-in-page hit, and needs no state of its own.
 */
export function Fold({ title, summary, children }: { title: string; summary: string; children: ReactNode }) {
  return (
    <details className="stat-fold">
      <summary>
        <span className="fold-title">{title}</span>
        <span className="fold-summary">{summary}</span>
      </summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}
