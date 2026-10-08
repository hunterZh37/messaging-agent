import { describe, it, expect } from "vitest";
import { draftContextReducer, openDraft, type DraftContextState } from "../lib/ask";
import { beganAsking, cardMeta, endedAsking, hasWhy, isAsking, isNewerChat, scoreTone, whyOpen } from "../lib/chat";

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

/**
 * Whether a tab adopts a conversation another tab (or the phone) just sent
 * back (2026-10-07, "two tabs... should only share one ground truth").
 */
describe("catching a tab up on Ask Celeste's conversation elsewhere", () => {
  it("takes the first copy of a context it has ever seen", () => {
    expect(isNewerChat(undefined, 100)).toBe(true);
  });

  it("takes a copy stamped after the one it is holding", () => {
    expect(isNewerChat(100, 200)).toBe(true);
  });

  it("drops a copy no newer than what it already has, so a pulse in flight before the newest turn landed cannot erase it", () => {
    expect(isNewerChat(200, 100)).toBe(false);
    expect(isNewerChat(200, 200)).toBe(false);
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

/**
 * The guard that keeps a tab's own question safe from another tab's pulse.
 * It is a count because two questions can be out for one conversation at
 * once, and a single flag let the first answer back open the door while the
 * second was still in flight (review, 2026-10-07).
 */
describe("beganAsking / endedAsking / isAsking", () => {
  it("is closed while a question is out and open again once it is back", () => {
    const counts = new Map<string, number>();
    expect(isAsking(counts, "general")).toBe(false);
    beganAsking(counts, "general");
    expect(isAsking(counts, "general")).toBe(true);
    endedAsking(counts, "general");
    expect(isAsking(counts, "general")).toBe(false);
  });

  /** The dropped file's question and the typed one, the first answer landing first. */
  it("stays closed while a second question for the same conversation is still out", () => {
    const counts = new Map<string, number>();
    beganAsking(counts, "general");
    beganAsking(counts, "general");
    endedAsking(counts, "general");
    expect(isAsking(counts, "general")).toBe(true);
    endedAsking(counts, "general");
    expect(isAsking(counts, "general")).toBe(false);
  });

  it("closes one conversation without closing another", () => {
    const counts = new Map<string, number>();
    beganAsking(counts, "a1:t1");
    expect(isAsking(counts, "a1:t1")).toBe(true);
    expect(isAsking(counts, "general")).toBe(false);
  });

  /** An answer with no question is nobody's: it must not leave a count behind. */
  it("never counts below nothing", () => {
    const counts = new Map<string, number>();
    endedAsking(counts, "general");
    expect(isAsking(counts, "general")).toBe(false);
    expect(counts.size).toBe(0);
  });
});

/**
 * The card that replaces the grey one-line chip (spec 2026-10-07). Its two
 * jobs are to say how strongly a message matched and to be honest when
 * nothing ranked it.
 */
describe("scoreTone", () => {
  it("greys a score below 70, so a weak match cannot dress up as a strong one", () => {
    expect(scoreTone(92)).toBe("strong");
    expect(scoreTone(70)).toBe("strong");
    expect(scoreTone(69)).toBe("weak");
    expect(scoreTone(0)).toBe("weak");
  });
});

describe("cardMeta", () => {
  const base = { messageId: "m1", threadId: "t1", subject: "Budget", from: "Keith Calix <keith@example.com>" };

  it("reads as who it is from and when, with the address left off", () => {
    expect(cardMeta({ ...base, sentAt: Date.parse("2026-09-12T10:00:00Z") })).toMatch(/^Keith Calix · /);
    expect(cardMeta({ ...base, sentAt: Date.parse("2026-09-12T10:00:00Z") })).not.toMatch(/@/);
  });

  /** A turn stored before cards existed carries a sender and nothing else. */
  it("says only what the citation actually carries", () => {
    expect(cardMeta(base)).toBe("Keith Calix");
  });

  it("falls back to the address when there is no name", () => {
    expect(cardMeta({ ...base, from: "noreply@example.com" })).toBe("noreply@example.com");
  });
});

/**
 * The popover on the score (spec 2026-10-07). The sentence itself is written
 * on the server, where the search terms are known — a citation carries no
 * query — so the panel's job is only to decide when to show it.
 */
describe("whyOpen", () => {
  it("opens for the card the operator is on, and nothing else", () => {
    expect(whyOpen("m1", "m1")).toBe(true);
    expect(whyOpen("m1", "m2")).toBe(false);
    expect(whyOpen("m1", null)).toBe(false);
  });
});

describe("hasWhy", () => {
  const base = { messageId: "m1", threadId: "t1", subject: "Budget", from: "Keith <k@example.com>" };

  it("is there when a search ranked it", () => {
    expect(hasWhy({ ...base, score: 92, why: "Matched “invoice”; sent today." })).toBe(true);
  });

  /** Nothing ranked it, so there is no score to hover and nothing to explain. */
  it("is not there for a citation nothing ranked", () => {
    expect(hasWhy(base)).toBe(false);
    expect(hasWhy({ ...base, score: 92 })).toBe(false);
  });
});
