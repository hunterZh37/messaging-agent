/**
 * Which draft the Ask panel is looking at (spec 10c, 2026-09-10). The card on
 * screen registers itself, and Celeste reads what is registered: "Looking at:
 * draft to X", the words a question carries, and where "Apply to draft" puts
 * her wording. Pure and outside React because the order these arrive in is
 * the whole difficulty — a card that is leaving and a card that is arriving
 * both speak, and the panel has to end up on the one that is there.
 */
export interface DraftContextState<T extends { draftId: string }> {
  /** The card that has said it is on screen, whatever the operator has done with the chip. */
  registered: T | null;
  /** The draft whose chip the operator took off, so it stops riding along with questions. */
  clearedId: string | null;
}

export type DraftContextEvent<T extends { draftId: string }> =
  /** A card is on screen, or the one on screen has new text. The newest wins. */
  | { type: "register"; draft: T }
  /** A card is gone, by name. */
  | { type: "forget"; draftId: string }
  /** The × on the chip: this draft stops being what the panel is looking at. */
  | { type: "clear" }
  /** The tab back (2026-09-14): the draft on screen is what the panel looks at again. */
  | { type: "resume" };

export function draftContextReducer<T extends { draftId: string }>(
  s: DraftContextState<T>,
  e: DraftContextEvent<T>,
): DraftContextState<T> {
  switch (e.type) {
    /**
     * The card that has just painted is the one Celeste is looking at. A chip
     * the operator cleared stays cleared while that same draft is on screen,
     * because clearing is about the questions they are about to ask; another
     * draft puts the chip back, and the id it named goes with it.
     */
    case "register":
      return { registered: e.draft, clearedId: s.clearedId === e.draft.draftId ? s.clearedId : null };
    /**
     * Only the card on the books can say it is gone. React can run a leaving
     * card's cleanup after the arriving card has registered — switching drafts
     * does exactly that — and an unnamed clear would then take the chip off
     * the card that is on screen, leaving Celeste to answer "the draft isn't
     * open" over a draft the operator is looking at.
     */
    case "forget":
      return s.registered?.draftId === e.draftId ? { ...s, registered: null } : s;
    case "clear":
      return { ...s, clearedId: s.registered?.draftId ?? null };
    case "resume":
      return { ...s, clearedId: null };
  }
}

/** What Celeste is told about: the card on screen, unless its chip was cleared. */
export function openDraft<T extends { draftId: string }>(s: DraftContextState<T>): T | null {
  return s.registered && s.registered.draftId !== s.clearedId ? s.registered : null;
}
