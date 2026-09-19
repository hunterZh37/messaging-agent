import { describe, it, expect } from "vitest";
import { addressedToOperator, isBroadcast, looksLikeList } from "../../src/sort/broadcast";
import { renderSortUserMessage, settle } from "../../src/sort/sorter";
import type { SortInput, SortResult } from "../../src/sort/types";

/**
 * A mailing-list announcement that reached Need to reply (operator,
 * 2026-09-18: "this emails should be under safe to delete").
 *
 * The shape of the real one, with the addresses replaced: a list rewrote the
 * sender into "… via ases-public", the only recipient was the list, and the
 * subject carried the word RSVP. The model was shown From, Subject and the
 * body and nothing else, so it read a personal scheduling request.
 */
const listMail: SortInput = {
  fromAddress: "ases-public@lists.example.com",
  fromName: "Max Zimo Fan via ases-public",
  toAddresses: ["ases-public@lists.example.com"],
  ccAddresses: [],
  operatorAddress: "hunter@example.com",
  subject: "[ases-public] [RSVP] Fireside Chat with a partner on 10/8",
  bodyText: "Hi everyone! Join us for a conversation. RSVP here.",
  attachmentNames: [],
  sentAt: 1_789_700_000_000,
};

const verdict = (over: Partial<SortResult> = {}): SortResult => ({
  important: true,
  needs_reply: true,
  scheduling: true,
  category: "Scheduling",
  finance: "none",
  disposable: false,
  project: "No project",
  reason: "This is a scheduling request, requiring a response to RSVP.",
  ...over,
});

describe("mail sent to a list rather than to you", () => {
  it("reads the list marks off the envelope", () => {
    expect(looksLikeList(listMail)).toBe(true);
    expect(addressedToOperator(listMail)).toBe(false);
    expect(isBroadcast(listMail)).toBe(true);
  });

  it("catches the rewritten sender a list leaves behind, on its own", () => {
    expect(looksLikeList({ ...listMail, fromAddress: "someone@example.com", toAddresses: ["group@example.com"] })).toBe(true);
  });

  it("catches the addresses a list is sent from", () => {
    const bounces = { ...listMail, fromName: "Announcements", fromAddress: "announce-bounces@example.com", toAddresses: ["announce@example.com"] };
    expect(looksLikeList(bounces)).toBe(true);
  });

  /** The correction is about who was addressed, so being on the list undoes it. */
  it("is not a broadcast when you are actually in To", () => {
    const toMe = { ...listMail, toAddresses: ["ases-public@lists.example.com", "hunter@example.com"] };
    expect(isBroadcast(toMe)).toBe(false);
  });

  it("is not a broadcast when a person writes to you directly", () => {
    const direct: SortInput = { ...listMail, fromAddress: "dana@example.com", fromName: "Dana", toAddresses: ["hunter@example.com"], subject: "Contract" };
    expect(isBroadcast(direct)).toBe(false);
  });

  /** Nothing is suppressed on a guess: an unknown envelope is treated as addressed. */
  it("assumes it is addressed to you when it cannot tell", () => {
    expect(addressedToOperator({ ...listMail, operatorAddress: null })).toBe(true);
    expect(addressedToOperator({ ...listMail, toAddresses: [] })).toBe(true);
    expect(isBroadcast({ ...listMail, operatorAddress: null })).toBe(false);
  });

  it("reads an address inside a display name", () => {
    expect(addressedToOperator({ ...listMail, toAddresses: ['"Hunter Z" <HUNTER@example.com>'] })).toBe(true);
  });
});

describe("the verdict, once the envelope is read", () => {
  it("takes a broadcast out of Need to reply and says why", () => {
    const out = settle(listMail, verdict());
    expect(out.needs_reply).toBe(false);
    expect(out.reason).toContain("sent to a list you are not addressed on");
  });

  /**
   * Worth keeping is a separate question from owed an answer. A list the
   * operator reads on purpose and one they never open look identical from
   * the envelope, so that call stays with the model.
   */
  it("says nothing about whether the mail is worth keeping", () => {
    const out = settle(listMail, verdict({ disposable: false, important: true }));
    expect(out.disposable).toBe(false);
    expect(out.important).toBe(true);
    expect(settle(listMail, verdict({ disposable: true })).disposable).toBe(true);
  });

  it("leaves a verdict alone when no reply was claimed", () => {
    const quiet = verdict({ needs_reply: false });
    expect(settle(listMail, quiet)).toBe(quiet);
  });

  it("leaves mail actually addressed to you alone", () => {
    const direct: SortInput = { ...listMail, fromAddress: "dana@example.com", fromName: "Dana", toAddresses: ["hunter@example.com"] };
    const v = verdict();
    expect(settle(direct, v)).toBe(v);
  });
});

describe("what the sorter shows the model", () => {
  it("names the recipients and whether they include you", () => {
    const text = renderSortUserMessage(listMail);
    expect(text).toContain("To: ases-public@lists.example.com");
    expect(text).toContain("Addressed to you: no, you were not in To or Cc");
  });

  it("says so plainly when you are addressed", () => {
    const toMe = { ...listMail, toAddresses: ["hunter@example.com"] };
    expect(renderSortUserMessage(toMe)).toContain("Addressed to you: yes");
  });

  /** A thousand-recipient blast says how many rather than running for pages. */
  it("counts a long recipient list instead of printing it", () => {
    const many = { ...listMail, toAddresses: Array.from({ length: 30 }, (_, i) => `p${i}@example.com`) };
    const text = renderSortUserMessage(many);
    expect(text).toContain("and 22 more");
    expect(text).not.toContain("p29@example.com");
  });

  it("leaves the lines out entirely when there are no recipients to show", () => {
    const bare: SortInput = { ...listMail, toAddresses: [], ccAddresses: [], operatorAddress: null };
    const text = renderSortUserMessage(bare);
    expect(text).not.toContain("To:");
    expect(text).not.toContain("Addressed to you:");
  });
});
