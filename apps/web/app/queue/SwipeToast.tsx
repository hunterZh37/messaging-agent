"use client";

import { useRef, useState, type ReactNode } from "react";

/** How far a toast has to travel before letting go of it takes it away. */
const DISMISS_PX = 36;

/**
 * A toast that can be flicked away (operator, 2026-09-15: "I should be able to
 * swipe it up and make it disappear"). It follows the finger up or down, fades
 * as it goes, and past a short distance leaves; short of that it springs back.
 * A tap still reaches the Undo inside it, since nothing moves until the finger
 * does.
 */
export function SwipeToast({ className, onDismiss, children, role, label }: { className: string; onDismiss: () => void; children: ReactNode; role?: string; /** What the × says it is closing, for a screen reader. */ label?: string }) {
  const start = useRef<{ y: number; id: number } | null>(null);
  const [dy, setDy] = useState(0);
  const [leaving, setLeaving] = useState<0 | 1 | -1>(0);

  function down(e: React.PointerEvent) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // A mouse drag would otherwise select the page's text on the way; a tap
    // on Undo still clicks, since only a press on the toast itself is held.
    if (e.pointerType === "mouse" && !(e.target as HTMLElement).closest("button")) e.preventDefault();
    start.current = { y: e.clientY, id: e.pointerId };
  }
  function move(e: React.PointerEvent) {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    const d = e.clientY - s.y;
    if (Math.abs(d) < 4 && dy === 0) return;
    // Once it moves, the toast has the pointer, so a drag off its edge still counts.
    try {
      if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* a pointer the browser no longer tracks: the drag still follows it */
    }
    setDy(d);
  }
  function up(e: React.PointerEvent) {
    const s = start.current;
    start.current = null;
    if (!s || s.id !== e.pointerId) return;
    if (Math.abs(dy) >= DISMISS_PX) {
      setLeaving(dy < 0 ? -1 : 1);
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      window.setTimeout(onDismiss, reduced ? 0 : 180);
      return;
    }
    setDy(0);
  }

  const style = leaving
    ? { transform: `translateY(${leaving * 120}%)`, opacity: 0, transition: "transform 180ms ease-in, opacity 180ms ease-in" }
    : dy !== 0
      ? { transform: `translateY(${dy}px)`, opacity: Math.max(0.2, 1 - Math.abs(dy) / 120), transition: "none" }
      : { transition: "transform 200ms cubic-bezier(0.2, 0.8, 0.3, 1), opacity 200ms" };

  return (
    <div
      className={`${className} swipeable`}
      role={role}
      style={style}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => {
        start.current = null;
        setDy(0);
      }}
    >
      {children}
      {/* A click closes it where there is a pointer rather than a finger
          (operator, 2026-09-15); the drag does the same either way. */}
      <button
        type="button"
        className="toast-x"
        aria-label={label ? `Dismiss: ${label}` : "Dismiss"}
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}
