"use client";

import { useState } from "react";
import { progressFraction, progressLabel, type PendingSend, type PendingTrash, type SentNotice, type TrashNotice } from "@/lib/queue";
import { SwipeToast } from "./SwipeToast";

/**
 * What the gate says, wherever the operator has got to (spec 8, 10a): the six
 * seconds between the click and the act, with Undo as the only button — there
 * is nothing to cancel, because nothing has happened yet, and letting the
 * toast run out is what does it. Then, once it has happened, a few seconds of
 * "Sent to <recipient>" or "Deleted N threads", because the countdown used to
 * simply vanish and the operator had no way to tell an act that worked from
 * one that never happened (2026-09-10).
 *
 * Two kinds of job share it: a send and a delete. A delete has no countdown
 * and, when it works, no toast either (operator, 2026-09-11: "just delete
 * instantly", then "do not display that"): the row going is the word, and
 * Cmd-Z brings the mail back out of Trash. A delete that failed, and a
 * restore, are said. One made by touch is said too, with Undo on it, since
 * a phone has no Cmd-Z (2026-09-11, the phone pass).
 */
/** A toast offers Undo while any delete it counts, or its own undo, is still there to take back. */
function canUndo(n: { id: string; undoJobId?: string; undoJobIds?: string[] }, undoable: string[]): boolean {
  const ids = n.undoJobIds ?? (n.undoJobId ? [n.undoJobId] : []);
  return undoable.includes(n.id) || ids.some((id) => undoable.includes(id));
}

export function SendToasts({
  pending,
  sent,
  trash,
  trashInFlight = [],
  trashed,
  now,
  undoable,
  onUndo,
  onUndoDelete,
}: {
  pending: PendingSend[];
  sent: SentNotice[];
  trash: PendingTrash[];
  /** Deletes the server is working through: a delete of many shows its progress (operator, 2026-09-13). */
  trashInFlight?: PendingTrash[];
  trashed: TrashNotice[];
  now: number;
  /** Delete jobs that can still be taken back. */
  undoable: string[];
  onUndo: (draftId: string) => void;
  onUndoDelete: (jobId: string) => void;
}) {
  // Toasts flicked away (2026-09-15). A send still counting down is never
  // among them: its Undo is the only way back, so it stays until it is done.
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const dismiss = (key: string) => setGone((prev) => new Set(prev).add(key));
  // A queued delete is on its way already; it is said once it has happened.
  void trash;
  // One of a few threads is over before a bar could mean anything.
  const working = trashInFlight.filter((j) => j.threadIds.length >= 3).filter((j) => !gone.has(`working-${j.id}`));
  const sentShown = sent.filter((n) => !gone.has(`sent-${n.draftId}`));
  const trashedShown = trashed.filter((n) => !gone.has(`trashed-${n.id}`));
  if (pending.length === 0 && sentShown.length === 0 && trashedShown.length === 0 && working.length === 0) return null;
  const secondsLeft = (endsAt: number) => Math.max(0, Math.ceil((endsAt - now) / 1000));
  return (
    <div className="toasts">
      {sentShown.map((n) => (
        <SwipeToast key={`sent-${n.draftId}`} className="toast done" role="status" label={n.label} onDismiss={() => dismiss(`sent-${n.draftId}`)}>
          <span>{n.label}</span>
        </SwipeToast>
      ))}
      {working.map((j) => {
        // Null until the first chunk lands, which for most deletes is the
        // whole job: the bar sweeps instead of filling rather than sit at
        // zero for the entire delete (operator, 2026-09-18).
        const fraction = progressFraction(j);
        return (
          <SwipeToast key={`working-${j.id}`} className="toast working" role="status" label={progressLabel(j)} onDismiss={() => dismiss(`working-${j.id}`)}>
            <span aria-live="polite">{progressLabel(j)}</span>
            <span className="toast-progress" aria-hidden="true">
              <span
                className={fraction === null ? "toast-progress-bar waiting" : "toast-progress-bar"}
                style={fraction === null ? undefined : { transform: `scaleX(${fraction})` }}
              />
            </span>
          </SwipeToast>
        );
      })}
      {trashedShown.map((n) => (
        <SwipeToast
          key={`trashed-${n.id}`}
          className={canUndo(n, undoable) ? "toast done undoable" : "toast done"}
          role="status"
          label={n.label}
          onDismiss={() => dismiss(`trashed-${n.id}`)}
        >
          <span>{n.label}</span>
          {canUndo(n, undoable) ? (
            <button type="button" className="undo" onClick={() => onUndoDelete(n.id)}>
              Undo
            </button>
          ) : null}
        </SwipeToast>
      ))}
      {pending.map((p) => (
        <div key={p.draftId} className="toast">
          <span>
            Sending to {p.to[0]}
            {p.to.length > 1 ? ` +${p.to.length - 1}` : ""}
            {/* A text goes at once: nothing to count down, nothing to undo. */}
            {secondsLeft(p.endsAt) > 0 ? ` in ${secondsLeft(p.endsAt)}s` : "…"}
          </span>
          {secondsLeft(p.endsAt) > 0 ? (
            <button type="button" className="undo" onClick={() => onUndo(p.draftId)}>
              Undo
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
