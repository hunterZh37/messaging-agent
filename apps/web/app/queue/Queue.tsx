"use client";

import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { DraftView } from "@messaging-agent/core";
import { draftHref } from "@/lib/queue";
import { neighbourThread } from "@/lib/threads";
import { DraftCard } from "./DraftCard";
import { DraftList } from "./DraftList";
import { DraftsHeader } from "./DraftsHeader";
import { useDraftQueue } from "./useDraftQueue";

/**
 * The Drafts folder (spec 10a): two panes like every other folder, the queue
 * on the left and the draft card on the right. The list is client state
 * rather than the server's, because Skip and Send take a draft out of it at
 * once and the 6-second cancel window has to be able to put it back; the
 * server's list is taken again on every refresh, so a draft Celeste has just
 * written joins the queue under the operator's eyes.
 */
export function Queue(props: {
  items: DraftView[];
  /** `?draft=`: which draft is open. Absent means the first one. */
  selected: string | undefined;
  /** `?account=`, carried by every row link so the inbox switcher's choice survives a click. */
  account: string | undefined;
  /** The inbox switcher, in the header beside the count (2026-09-15). */
  switcher?: ReactNode;
}) {
  const router = useRouter();
  const q = useDraftQueue(props.items, {
    onLeave: (draftId) => advanceFrom(draftId),
    // Undone inside the window: the card is back in the queue, so open it.
    onReturn: (draftId) => select(draftId),
    // The card is back with an error on it, so put the operator in front of it.
    onSendFailed: (draftId) => select(draftId),
  });
  const { mode, setMode } = q;

  // The URL names the open draft; anything it names that has since left the
  // list falls back to the top, so a stale `?draft=` never empties the pane.
  const explicit = q.items.some((i) => i.draft.id === props.selected) ? props.selected! : null;
  const current = q.items.find((i) => i.draft.id === explicit) ?? q.items[0] ?? null;

  // Minimal shortcuts (spec 10a): s send, x skip, Esc back, and j/k or the
  // arrows down and up the list. Never while typing, which is most of the
  // time now that the draft body is always a field (operator, 2026-09-20).
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      const t = ev.target as HTMLElement | null;
      const typing = t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT");
      if (ev.key === "Escape") { setMode("view"); return; }
      if (typing || !current) return;
      if (ev.key === "s" && mode !== "confirm") setMode("confirm");
      if (ev.key === "x" && mode !== "confirm") q.skip(current.draft.id);
      // Down and up the list, the way every mail client reads them. Only
      // while the card is being read: inside the gate the arrows are the
      // dialog's, and while editing the guard above has already returned.
      if (mode !== "view") return;
      const ids = q.items.map((i) => i.draft.id);
      const at = ids.indexOf(current.draft.id);
      const step = ev.key === "j" || ev.key === "ArrowDown" ? 1 : ev.key === "k" || ev.key === "ArrowUp" ? -1 : 0;
      const to = step === 0 ? undefined : ids[at + step];
      if (to) {
        ev.preventDefault();
        select(to);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }); // intentionally re-bound each render so it sees fresh mode/current

  /** Which draft is open, said in the URL so a reload and the back button agree. */
  function select(draftId: string | null) {
    router.replace(draftHref(draftId, props.account));
  }

  /**
   * A draft has left the list: the operator lands on the one below it, or the
   * one above when it was last, or on the empty state. The tree's "Drafts · N"
   * is server-rendered, so it is asked again here or it would go on counting
   * a draft that is no longer waiting.
   */
  function advanceFrom(draftId: string) {
    // `q.items` is this render's list, which still holds the draft: the
    // neighbour is read from where it sat, not from where it has gone.
    select(neighbourThread(q.items.map((i) => i.draft.id), draftId));
    router.refresh();
  }

  return (
    <>
      <DraftsHeader count={q.items.length} switcher={props.switcher} />
      <div className="inbox-grid">
        <div className={`inbox-list${explicit ? " with-detail" : ""}`}>
          {q.items.length === 0 ? (
            <div className="inbox-empty meta">No drafts</div>
          ) : (
            <DraftList items={q.items} selectedId={current?.draft.id ?? null} account={props.account} />
          )}
        </div>
        {/* Chosen for the operator rather than by them, so on a phone this
            pane waits for a tap instead of hiding the list behind it. */}
        <div className={`inbox-detail${current && !explicit ? " implicit" : ""}`}>
          {current ? (
            <>
              <Link href={draftHref(null, props.account)} className="inbox-back">← Drafts</Link>
              <DraftCard
                key={current.draft.id}
                view={current}
                mode={mode}
                setMode={setMode}
                error={q.errors[current.draft.id]}
                initialEdit={q.edits[current.draft.id]}
                onConfirm={(finalText, to, cc) => q.confirmSend(current.draft.id, finalText, to, cc)}
                onSkip={(edit) => q.skip(current.draft.id, edit)}
                remaining={q.items.length}
              />
            </>
          ) : (
            /* An empty queue keeps both panes and the tree: a folder with
               nothing in it, not a page with nothing on it. The line says
               where drafts come from, naming the button by the words on it,
               since nothing on this screen makes one. When mail was last
               pulled is the header's to say, once, after mount. */
            <div className="inbox-empty">
              <div className="empty-title">No drafts waiting</div>
              <div className="meta">
                Celeste drafts a reply when a thread needs one. Open a thread and press <b>Draft with Celeste</b> to ask for one now.
              </div>
            </div>
          )}
        </div>
      </div>

    </>
  );
}
