import { describe, it, expect } from "vitest";
import { groupByThread } from "../lib/threads";

const row = (id: string, thread: string, sentAt: number) => ({ id, thread: { id: thread }, message: { sentAt } });
const ids = <T extends { id: string }>(rows: T[]) => rows.map((r) => r.id);

describe("groupByThread", () => {
  it("gives a thread one row and folds the rest under it", () => {
    const groups = groupByThread([row("a", "t1", 300), row("b", "t1", 200), row("c", "t2", 100)]);
    expect(groups.map((g) => g.threadId)).toEqual(["t1", "t2"]);
    expect(groups[0]!.latest.id).toBe("a");
    expect(ids(groups[0]!.older)).toEqual(["b"]);
    expect(groups[1]!.older).toEqual([]);
  });

  it("keeps a thread where its newest message sat, not where its oldest did", () => {
    // t2's only message is newer than t1's newest, so t2 stays on top.
    const groups = groupByThread([row("new", "t2", 500), row("mid", "t1", 400), row("old", "t1", 100)]);
    expect(groups.map((g) => g.threadId)).toEqual(["t2", "t1"]);
  });

  it("decides which message stands for a thread itself, whatever order it is given", () => {
    const groups = groupByThread([row("old", "t1", 100), row("new", "t1", 300), row("mid", "t1", 200)]);
    expect(groups[0]!.latest.id).toBe("new");
    expect(ids(groups[0]!.older)).toEqual(["mid", "old"]);
  });

  it("has nothing to fold when every row is its own thread", () => {
    const groups = groupByThread([row("a", "t1", 200), row("b", "t2", 100)]);
    expect(groups.every((g) => g.older.length === 0)).toBe(true);
  });

  it("is empty for an empty list", () => {
    expect(groupByThread([])).toEqual([]);
  });
});

describe("neighbourThread", () => {
  it("prefers the thread below, then the one above, then nothing", async () => {
    const { neighbourThread } = await import("../lib/threads");
    expect(neighbourThread(["a", "b", "c"], "b")).toBe("c");
    expect(neighbourThread(["a", "b", "c"], "c")).toBe("b");
    expect(neighbourThread(["a"], "a")).toBe(null);
    expect(neighbourThread(["a", "b"], "zzz")).toBe("a");
  });
});

describe("runAfter", () => {
  // Operator, 2026-09-11: pressing Delete again before the next thread has
  // shown up should delete that next thread, and so on down the list.
  it("walks below first, then up from the nearest, and never the current", async () => {
    const { runAfter } = await import("../lib/threads");
    expect(runAfter(["a", "b", "c", "d"], "b")).toEqual(["c", "d", "a"]);
    expect(runAfter(["a", "b", "c"], "c")).toEqual(["b", "a"]);
    expect(runAfter(["a"], "a")).toEqual([]);
    expect(runAfter(["a", "b"], "zzz")).toEqual(["a", "b"]);
  });

  it("agrees with the neighbour rule about the first step", async () => {
    const { runAfter, neighbourThread } = await import("../lib/threads");
    for (const cur of ["a", "b", "c"]) expect(runAfter(["a", "b", "c"], cur)[0] ?? null).toBe(neighbourThread(["a", "b", "c"], cur));
  });
});
