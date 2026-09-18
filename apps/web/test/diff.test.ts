import { describe, it, expect } from "vitest";
import { diffLines } from "../lib/diff";
import { changeCount, wordDiff } from "../lib/diff";

describe("diffLines", () => {
  it("marks unchanged text as same", () => {
    expect(diffLines("a\nb", "a\nb")).toEqual([{ kind: "same", text: "a" }, { kind: "same", text: "b" }]);
  });
  it("marks a changed line as del + add", () => {
    expect(diffLines("a\nb\nc", "a\nB\nc")).toEqual([
      { kind: "same", text: "a" }, { kind: "del", text: "b" }, { kind: "add", text: "B" }, { kind: "same", text: "c" },
    ]);
  });
  it("handles insertions and deletions at the ends", () => {
    expect(diffLines("a", "a\nb")).toEqual([{ kind: "same", text: "a" }, { kind: "add", text: "b" }]);
    expect(diffLines("x\na", "a")).toEqual([{ kind: "del", text: "x" }, { kind: "same", text: "a" }]);
  });
});


describe("wordDiff", () => {
  it("marks the one word a revision added", () => {
    const parts = wordDiff("That is the letter I was talking. Next.", "That is the letter I was talking about. Next.");
    expect(parts.filter((p) => p.kind !== "same")).toEqual([
      { kind: "del", text: "talking." },
      { kind: "ins", text: "talking about. " },
    ]);
    expect(changeCount(parts)).toBe(1);
  });

  it("shows what a shorter draft dropped", () => {
    const parts = wordDiff("Thanks for sending this over. We will review it.\n\nHunter", "Thanks for sending this over.\n\nHunter");
    expect(parts.map((p) => p.kind)).toEqual(["same", "del", "same"]);
    expect(parts[1]?.text.trim()).toBe("We will review it.");
  });

  it("is all the same when nothing changed, and counts separate places", () => {
    expect(wordDiff("a b c", "a b c")).toEqual([{ kind: "same", text: "a b c" }]);
    expect(changeCount(wordDiff("one two three four", "1 two three 4"))).toBe(2);
  });
});
