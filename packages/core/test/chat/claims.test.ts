import { describe, it, expect } from "vitest";
import { changesTheDraft, claimsDraftChanged } from "../../src/chat/claims";
import type { ProposedAction } from "../../src/chat/types";

/**
 * "Draft updated on your screen", over a card that had not moved (operator,
 * 2026-09-24: "draft did not get updated"). Reproduced: Celeste answered with
 * no proposal at all and said the change was done. A claim about what is on
 * their screen is checked like a quote, so it has to be readable as a claim
 * in the first place.
 */

const OPEN = "a1:t1";

describe("claimsDraftChanged", () => {
  it("reads the sentences that say it is already done", () => {
    for (const said of [
      "The draft is updated on your screen: it now mentions the folder.",
      "Draft updated on your screen with the role clarifications.",
      "I've revised the draft to say that.",
      "I updated your draft to add the link.",
      "The draft now says you are waiting on two more letters.",
      "Applied it to the draft.",
    ]) {
      expect(claimsDraftChanged(said), said).toBe(true);
    }
  });

  it("leaves an offer, a question and a plan alone", () => {
    for (const said of [
      "I can update the draft to say that if you like.",
      "Shall I update the draft, or write a new one?",
      "I'll update the draft once you tell me which thread you mean.",
      "Do you want me to revise the draft?",
      "Would you like the draft rewritten to say it instead?",
      "There is no draft open, so there is nothing to change.",
    ]) {
      expect(claimsDraftChanged(said), said).toBe(false);
    }
  });
});

describe("changesTheDraft", () => {
  const apply = (text: string): ProposedAction => ({ kind: "apply_draft", threadIds: [OPEN], text });
  const draftReply = (threadId: string, instruction?: string): ProposedAction => ({
    kind: "draft_reply",
    threadIds: [threadId],
    ...(instruction ? { instruction } : {}),
  });

  it("is true for an apply carrying a body", () => {
    expect(changesTheDraft([apply("Hi Ana\n\nTuesday works.")], OPEN)).toBe(true);
  });

  it("is false for an apply carrying nothing", () => {
    expect(changesTheDraft([apply("   ")], OPEN)).toBe(false);
  });

  /** The panel runs this one itself over the open card (see revisesOpenDraft). */
  it("is true for a draft proposal over the open draft's own thread, with words to go on", () => {
    expect(changesTheDraft([draftReply(OPEN, "say the folder is ready")], OPEN)).toBe(true);
  });

  it("is false for a draft proposal over another thread, or with no instruction", () => {
    expect(changesTheDraft([draftReply("a1:other", "say the folder is ready")], OPEN)).toBe(false);
    expect(changesTheDraft([draftReply(OPEN)], OPEN)).toBe(false);
  });

  it("is false when nothing was proposed at all, which is what happened", () => {
    expect(changesTheDraft([], OPEN)).toBe(false);
    expect(changesTheDraft([{ kind: "mark_handled", threadIds: [OPEN] }], OPEN)).toBe(false);
  });

  it("is false when no draft is open, whatever was proposed", () => {
    expect(changesTheDraft([draftReply(OPEN, "say it")], null)).toBe(false);
  });
});
