"use client";

import { useMemo, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { DraftView } from "@messaging-agent/core";
import { CelesteMark } from "../../queue/CelesteMark";
import { DraftCard } from "../../queue/DraftCard";
import { useDraftQueue } from "../../queue/useDraftQueue";
import { DraftReplyButton } from "./DraftReplyButton";

/**
 * The thread's pending draft, under the mail it answers (spec 10a,
 * 2026-09-10). Operator: "if I ask Celeste on the right-hand panel to draft an
 * email, that draft should pop up on the left-hand side under the content of
 * the email as if we're replying to them automatically." So the reply is
 * written where the mail is read, and the queue is the same cards gathered in
 * one place rather than the only place they exist.
 *
 * It is the queue's own card and the queue's own send: the six seconds with an
 * Undo, the edits, the failures, all through `useDraftQueue`, so Send here and
 * Send in the Drafts folder are one behaviour. The action row lives here too,
 * because whether it offers "Draft with Celeste" depends on whether this card
 * is on screen, and the rest of the row is handed in as it stands.
 */
export function ThreadDraftHost({
  view,
  threadId,
  followUp,
  children,
  text = false,
  canReply = true,
}: {
  /** The thread's pending draft, or null when it has none. */
  view: DraftView | null;
  threadId: string;
  /** The operator spoke last, so what Celeste writes is a nudge, not an answer. */
  followUp: boolean;
  /** The rest of the action row: Mark handled, No reply needed, Move to project. */
  children: ReactNode;
  /** A chat, not mail (2026-09-11): the button says reply, not draft. */
  text?: boolean;
  /** False where a reply could never be sent, so there is nothing to draft (2026-09-16). */
  canReply?: boolean;
}) {
  const router = useRouter();
  // One card, in the same list the Drafts folder keeps, so nothing here has to
  // know how a send works. A fresh array on every server render is what tells
  // the hook the draft has arrived or gone.
  const items = useMemo(() => (view ? [view] : []), [view]);
  const q = useDraftQueue(items, {
    // Sent or skipped: the card goes, and the tree's counts and this page's
    // own action row are the server's to say again.
    onLeave: () => router.refresh(),
    onReturn: () => router.refresh(),
  });
  const card = q.items[0] ?? null;

  return (
    <>
      {card ? (
        <section className="reply-card" aria-label="Celeste's reply">
          <div className="reply-lead">
            <CelesteMark suffix={card.draft.mode === "follow-up" ? "follow-up" : "reply"} />
            <span className="meta">Nothing is sent until you send it.</span>
          </div>
          <DraftCard
            key={card.draft.id}
            view={card}
            mode={q.mode}
            setMode={q.setMode}
            error={q.errors[card.draft.id]}
            initialEdit={q.edits[card.draft.id]}
            onConfirm={(finalText, to, cc) => q.confirmSend(card.draft.id, finalText, to, cc)}
            onSkip={(current) => q.skip(card.draft.id, current)}
            remaining={1}
            showThread={false}
          />
        </section>
      ) : null}
      <div className="row thread-actions">
        {/* The card above is the draft, so there is nothing here to open.
            A thread the operator wrote last gets no button either
            (operator, 2026-09-11: no Celeste drafts for sent mail, they
            only cost tokens). */}
        {card || followUp || !canReply ? null : <DraftReplyButton threadId={threadId} followUp={followUp} text={text} />}
        {children}
      </div>
    </>
  );
}
