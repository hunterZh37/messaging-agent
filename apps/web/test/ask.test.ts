import { describe, it, expect } from "vitest";
import { draftContextReducer, openDraft, type DraftContextState } from "../lib/ask";

interface Card {
  draftId: string;
  text: string;
}

const empty: DraftContextState<Card> = { registered: null, clearedId: null };
const card = (draftId: string, text = "hello"): Card => ({ draftId, text });

describe("which draft the Ask panel is looking at", () => {
  it("is the card that has painted", () => {
    const s = draftContextReducer(empty, { type: "register", draft: card("d1") });
    expect(openDraft(s)).toEqual(card("d1"));
  });

  it("is nothing at all before a card has said anything", () => {
    expect(openDraft(empty)).toBeNull();
  });

  it("follows the text on the card, so a question carries what is on screen", () => {
    let s = draftContextReducer(empty, { type: "register", draft: card("d1", "first") });
    s = draftContextReducer(s, { type: "register", draft: card("d1", "second") });
    expect(openDraft(s)?.text).toBe("second");
  });

  it("lets go when the card on screen says it is gone", () => {
    let s = draftContextReducer(empty, { type: "register", draft: card("d1") });
    s = draftContextReducer(s, { type: "forget", draftId: "d1" });
    expect(openDraft(s)).toBeNull();
  });

  /**
   * The failure the operator hit: with a draft open, Celeste answered "the
   * draft isn't open right now". A card leaving can clean up after its
   * replacement has registered, and an unnamed clear would empty the chip
   * the new card had just filled.
   */
  it("keeps the new card when the old one's goodbye arrives after it", () => {
    let s = draftContextReducer(empty, { type: "register", draft: card("d1") });
    s = draftContextReducer(s, { type: "register", draft: card("d2") });
    s = draftContextReducer(s, { type: "forget", draftId: "d1" });
    expect(openDraft(s)).toEqual(card("d2"));
  });

  it("ignores a goodbye from a card that was never on the books", () => {
    const s = draftContextReducer(empty, { type: "forget", draftId: "d9" });
    expect(s).toBe(empty);
  });
});

describe("the × on the draft chip", () => {
  it("stops the open draft riding along with the next question", () => {
    let s = draftContextReducer(empty, { type: "register", draft: card("d1") });
    s = draftContextReducer(s, { type: "clear" });
    expect(openDraft(s)).toBeNull();
  });

  it("holds while the same card paints again, so an edit does not undo it", () => {
    let s = draftContextReducer(empty, { type: "register", draft: card("d1", "first") });
    s = draftContextReducer(s, { type: "clear" });
    s = draftContextReducer(s, { type: "register", draft: card("d1", "second") });
    expect(openDraft(s)).toBeNull();
  });

  it("is over when another draft is on screen", () => {
    let s = draftContextReducer(empty, { type: "register", draft: card("d1") });
    s = draftContextReducer(s, { type: "clear" });
    s = draftContextReducer(s, { type: "register", draft: card("d2") });
    expect(openDraft(s)).toEqual(card("d2"));
    expect(s.clearedId).toBeNull();
  });

  it("clears nothing when there is no card to clear", () => {
    expect(draftContextReducer(empty, { type: "clear" }).clearedId).toBeNull();
  });
});

describe("the tab back to the draft on screen (2026-09-14)", () => {
  const empty: DraftContextState<{ draftId: string }> = { registered: null, clearedId: null };
  it("resume undoes a clear while the same card is on screen", () => {
    let s = draftContextReducer(empty, { type: "register", draft: { draftId: "d1" } });
    s = draftContextReducer(s, { type: "clear" });
    expect(openDraft(s)).toBeNull();
    s = draftContextReducer(s, { type: "resume" });
    expect(openDraft(s)?.draftId).toBe("d1");
  });
});
