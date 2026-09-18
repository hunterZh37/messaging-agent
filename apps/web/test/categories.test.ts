import { describe, it, expect } from "vitest";
import { dropIndex, move } from "../lib/categories";

describe("move", () => {
  it("moves an item up and down", () => {
    expect(move(["a", "b", "c"], 2, 1)).toEqual(["a", "c", "b"]);
    expect(move(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
  });

  it("returns the same array for a no-op or out-of-range move", () => {
    const items = ["a", "b"];
    expect(move(items, 1, 1)).toBe(items);
    expect(move(items, 0, -1)).toBe(items);
    expect(move(items, 1, 2)).toBe(items);
  });
});


describe("dropIndex", () => {
  const reorder = (items: string[], from: number, over: number, below: boolean) =>
    move(items, from, dropIndex(from, over, below));

  it("drops a row above the one it was dropped on", () => {
    expect(reorder(["a", "b", "c"], 2, 1, false)).toEqual(["a", "c", "b"]);
    expect(reorder(["a", "b", "c"], 2, 0, false)).toEqual(["c", "a", "b"]);
  });

  it("drops a row below the one it was dropped on", () => {
    expect(reorder(["a", "b", "c"], 0, 1, true)).toEqual(["b", "a", "c"]);
    expect(reorder(["a", "b", "c"], 0, 2, true)).toEqual(["b", "c", "a"]);
  });

  it("leaves the list alone when the row is dropped where it already is", () => {
    // Above the row below it, and below the row above it, are both no moves.
    expect(reorder(["a", "b", "c"], 0, 1, false)).toEqual(["a", "b", "c"]);
    expect(reorder(["a", "b", "c"], 1, 0, true)).toEqual(["a", "b", "c"]);
    expect(reorder(["a", "b", "c"], 1, 1, false)).toEqual(["a", "b", "c"]);
  });

  it("accounts for the slot the row frees on its way out", () => {
    // Dragging down: without the correction this lands one short.
    expect(dropIndex(0, 2, true)).toBe(2);
    // Dragging up: nothing has moved out from under the target.
    expect(dropIndex(2, 0, false)).toBe(0);
  });
});
