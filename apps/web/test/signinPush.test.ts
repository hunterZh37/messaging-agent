import { describe, it, expect } from "vitest";
import { signinChanges, signinNotice, announceSignin } from "../lib/signinPush";

/**
 * Telling the phone an inbox has stopped letting Celeste in (operator,
 * 2026-10-09). Two of their inboxes once sat locked out for two and a half
 * days, and the only sign was a panel they had to open Celeste to see.
 *
 * The mail clock runs every two minutes, so half the problem is saying it
 * once. The other half — found by review, 2026-10-09 — is that a notification
 * which was never delivered must not count as said, or the thing built to end
 * silent failure fails silently itself.
 */

describe("signinChanges", () => {
  it("calls an inbox new the first time it goes down", () => {
    expect(signinChanges(new Set(), ["a@example.com"])).toEqual({ fresh: ["a@example.com"], recovered: [] });
  });

  it("calls it nothing once it has been announced", () => {
    expect(signinChanges(new Set(["a@example.com"]), ["a@example.com"])).toEqual({ fresh: [], recovered: [] });
  });

  it("notices a second inbox without repeating the first", () => {
    expect(signinChanges(new Set(["a@example.com"]), ["a@example.com", "b@example.com"]).fresh).toEqual(["b@example.com"]);
  });

  it("reports an inbox that came back, so it can be forgotten", () => {
    expect(signinChanges(new Set(["a@example.com"]), [])).toEqual({ fresh: [], recovered: ["a@example.com"] });
  });

  /** It decides; the caller changes things. A failed send must be able to retry. */
  it("changes nothing it is given", () => {
    const said = new Set(["a@example.com"]);
    signinChanges(said, ["b@example.com"]);
    expect([...said]).toEqual(["a@example.com"]);
  });
});

describe("announceSignin", () => {
  const ok = async () => ({ sent: 1, gone: 0 });
  const failed = async () => ({ sent: 0, gone: 0 });

  it("says it once when the phone got it", async () => {
    const said = new Set<string>();
    expect(await announceSignin(said, ["a@example.com"], ok)).toEqual({ announced: ["a@example.com"], delivered: true });
    expect(await announceSignin(said, ["a@example.com"], ok)).toEqual({ announced: [], delivered: false });
  });

  /**
   * The review's finding: the set was changed before the send was confirmed,
   * so a push service returning 500 lost the notice for the whole outage.
   */
  it("tries again on the next tick when the send failed", async () => {
    const said = new Set<string>();
    expect(await announceSignin(said, ["a@example.com"], failed)).toEqual({ announced: ["a@example.com"], delivered: false });
    expect(said.size).toBe(0);
    // Next tick, the push service is back.
    expect(await announceSignin(said, ["a@example.com"], ok)).toEqual({ announced: ["a@example.com"], delivered: true });
    expect([...said]).toEqual(["a@example.com"]);
  });

  /** No phone subscribed yet is the same as a failed send: tell them when one is. */
  it("keeps trying while nothing is subscribed, and tells them when something is", async () => {
    const said = new Set<string>();
    await announceSignin(said, ["a@example.com"], failed);
    await announceSignin(said, ["a@example.com"], failed);
    expect(said.size).toBe(0);
    expect((await announceSignin(said, ["a@example.com"], ok)).delivered).toBe(true);
  });

  it("forgets an inbox that recovered even when nothing was sent", async () => {
    const said = new Set(["a@example.com"]);
    await announceSignin(said, [], failed);
    expect(said.size).toBe(0);
  });

  it("sends nothing when nothing is down", async () => {
    let called = 0;
    await announceSignin(new Set(), [], async () => { called++; return { sent: 0, gone: 0 }; });
    expect(called).toBe(0);
  });

  it("names every inbox currently down, not only the new one", async () => {
    const said = new Set<string>();
    let seen: { title: string } | null = null;
    await announceSignin(said, ["a@example.com"], async (n) => { seen = n; return { sent: 1, gone: 0 }; });
    await announceSignin(said, ["a@example.com", "b@example.com"], async (n) => { seen = n; return { sent: 1, gone: 0 }; });
    expect(seen!.title).toMatch(/2 inboxes/);
  });
});

describe("signinNotice", () => {
  it("names the one inbox when there is one", () => {
    const n = signinNotice(["a@example.com"]);
    expect(n.title).toMatch(/an inbox/i);
    expect(n.body).toContain("a@example.com");
    expect(n.url).toBe("/inboxes");
  });

  it("counts them when there are more", () => {
    expect(signinNotice(["a@example.com", "b@example.com"]).title).toMatch(/2 inboxes/);
  });

  it("uses one tag, so a later one replaces the earlier", () => {
    expect(signinNotice(["a@example.com"]).tag).toBe(signinNotice(["a@example.com", "b@example.com"]).tag);
  });
});
