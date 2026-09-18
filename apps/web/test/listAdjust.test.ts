import { describe, it, expect } from "vitest";
import { goneFromList, lessGone, listAdjust } from "../lib/listAdjust";

/** The counts drop with the cards, not when the provider is done (2026-09-15). */
describe("goneFromList", () => {
  it("counts rows and threads of this list that are leaving, and nothing that is not in it", () => {
    // A thread with two disposable messages is two rows and one thread.
    expect(goneFromList(["t1", "t1", "t2", "t3"], ["t1", "t9"])).toEqual({ rows: 2, threads: 1 });
    expect(goneFromList(["t1"], [])).toEqual({ rows: 0, threads: 0 });
  });

  it("is zero again once the fresh page no longer lists the deleted thread, so nothing is taken off twice", () => {
    expect(goneFromList(["t2", "t3"], ["t1"])).toEqual({ rows: 0, threads: 0 });
  });
});

describe("lessGone", () => {
  it("takes off what left and never goes below zero", () => {
    expect(lessGone(5, 2)).toBe(3);
    expect(lessGone(1, 3)).toBe(0);
    expect(lessGone(4, undefined)).toBe(4);
  });
});

describe("listAdjust", () => {
  it("tells subscribers when a list's gone count changes, and forgets a list that clears", () => {
    let calls = 0;
    const off = listAdjust.subscribe(() => calls++);
    listAdjust.set("inbox:disposable", { rows: 2, threads: 1 });
    listAdjust.set("inbox:disposable", { rows: 2, threads: 1 });
    expect(calls).toBe(1);
    expect(listAdjust.get("inbox:disposable")).toEqual({ rows: 2, threads: 1 });
    listAdjust.set("inbox:disposable", null);
    expect(listAdjust.get("inbox:disposable")).toBeUndefined();
    expect(calls).toBe(2);
    off();
  });
});
