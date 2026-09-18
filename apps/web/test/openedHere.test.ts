import { describe, it, expect } from "vitest";
import { openedHere, stillUnread } from "../lib/openedHere";

/** The unopened dot goes when the thread is opened in this tab (2026-09-15). */
describe("stillUnread", () => {
  it("goes quiet once opened after the message arrived", () => {
    expect(stillUnread(true, 100, undefined)).toBe(true);
    expect(stillUnread(true, 100, 150)).toBe(false);
    expect(stillUnread(false, 100, undefined)).toBe(false);
  });
  it("keeps the dot for a message that arrived after the open", () => {
    expect(stillUnread(true, 200, 150)).toBe(true);
  });
});

describe("openedHere", () => {
  it("remembers when a thread was opened and tells whoever listens", () => {
    let heard = 0;
    const off = openedHere.subscribe(() => heard++);
    const before = openedHere.version();
    openedHere.mark("t1", 500);
    expect(openedHere.at("t1")).toBe(500);
    expect(openedHere.version()).toBe(before + 1);
    expect(heard).toBe(1);
    off();
  });
});
