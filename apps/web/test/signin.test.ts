import { describe, it, expect } from "vitest";
import { askToSignIn, fixingSignin, signinKey } from "../lib/signin";

/**
 * The panel that says an inbox has stopped letting Celeste in (operator,
 * 2026-10-01: "make a pop-up and ask me to re-sign into these every single
 * time they happen. Right now they're hard to notice and I was wondering why
 * I had not received any emails from these two inboxes since last").
 *
 * Two of theirs had been locked out for two and a half days. What must not
 * happen is subtle in both directions: a panel that keeps coming back while
 * they work is unusable, and one that stays away is the silence they already
 * lived through.
 */

const BROKEN = ["b@example.com", "a@example.com"];

describe("signinKey", () => {
  it("is the same for the same inboxes, whatever order they arrive in", () => {
    expect(signinKey(["a@example.com", "b@example.com"])).toBe(signinKey(BROKEN));
  });

  it("is different once another inbox goes down", () => {
    expect(signinKey([...BROKEN, "c@example.com"])).not.toBe(signinKey(BROKEN));
  });
});

describe("fixingSignin", () => {
  it("knows the pages where they are already dealing with it", () => {
    expect(fixingSignin("/inboxes")).toBe(true);
    expect(fixingSignin("/connecting/abc-123")).toBe(true);
  });

  it("is false everywhere else", () => {
    for (const path of ["/inbox", "/drafts", "/messages", "/inbox/a1%3At1", "/people/x"]) {
      expect(fixingSignin(path)).toBe(false);
    }
  });
});

describe("askToSignIn", () => {
  it("asks when an inbox is locked out and nothing has been put off", () => {
    expect(askToSignIn(BROKEN, null, "/inbox")).toBe(true);
  });

  it("says nothing when every inbox is fine", () => {
    expect(askToSignIn([], null, "/inbox")).toBe(false);
  });

  /** The 3-second pulse re-reads the page constantly; the same answer must not re-ask. */
  it("stays away once they have put these very inboxes off", () => {
    expect(askToSignIn(BROKEN, signinKey(BROKEN), "/inbox")).toBe(false);
    // Even when the same inboxes arrive in the other order.
    expect(askToSignIn(["a@example.com", "b@example.com"], signinKey(BROKEN), "/inbox")).toBe(false);
  });

  it("asks again when a further inbox goes down, Later or no Later", () => {
    expect(askToSignIn([...BROKEN, "c@example.com"], signinKey(BROKEN), "/inbox")).toBe(true);
  });

  it("asks again when they are down to one, since it is a different answer", () => {
    expect(askToSignIn(["a@example.com"], signinKey(BROKEN), "/inbox")).toBe(true);
  });

  it("never asks over the page they fix it on", () => {
    expect(askToSignIn(BROKEN, null, "/inboxes")).toBe(false);
    expect(askToSignIn(BROKEN, null, "/connecting/abc-123")).toBe(false);
  });
});
