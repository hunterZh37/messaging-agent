import { describe, it, expect } from "vitest";
import { newlyDown, signinNotice } from "../lib/signinPush";

/**
 * Telling the phone an inbox has stopped letting Celeste in (operator,
 * 2026-10-09: "set up Celeste so that everything will be automated and
 * authenticated"). Two of their inboxes once sat locked out for two and a
 * half days, and the only sign was a panel they had to open Celeste to see.
 *
 * The mail clock runs every two minutes, so the whole problem is saying it
 * once rather than seven hundred times a day.
 */
describe("newlyDown", () => {
  it("announces an inbox the first time it goes down", () => {
    expect(newlyDown(new Set(), ["a@example.com"])).toEqual(["a@example.com"]);
  });

  it("says nothing on the next tick, and the next", () => {
    const said = new Set(["a@example.com"]);
    expect(newlyDown(said, ["a@example.com"])).toEqual([]);
  });

  it("announces a second inbox going down without repeating the first", () => {
    const said = new Set(["a@example.com"]);
    expect(newlyDown(said, ["a@example.com", "b@example.com"])).toEqual(["b@example.com"]);
  });

  /** Reconnected, then broken again later, is news again. */
  it("announces an inbox that recovered and then went down again", () => {
    const said = new Set(["a@example.com"]);
    expect(newlyDown(said, [])).toEqual([]);
    expect(said.has("a@example.com")).toBe(false);
    expect(newlyDown(said, ["a@example.com"])).toEqual(["a@example.com"]);
  });

  it("forgets an inbox that came back, so the set cannot grow for ever", () => {
    const said = new Set(["a@example.com", "b@example.com"]);
    newlyDown(said, ["b@example.com"]);
    expect([...said]).toEqual(["b@example.com"]);
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

  /** One notification that updates, rather than a pile of them on the lock screen. */
  it("uses one tag, so a later one replaces the earlier", () => {
    expect(signinNotice(["a@example.com"]).tag).toBe(signinNotice(["a@example.com", "b@example.com"]).tag);
  });
});
