import { describe, it, expect } from "vitest";
import { isDeleteKey, isHideKey, isUndoKey, nextThreadRow } from "../lib/keys";

const ev = (key: string, target: Partial<HTMLElement> | null = null, mods = {}) =>
  ({ key, metaKey: false, ctrlKey: false, altKey: false, target: target as EventTarget | null, ...mods });

describe("isDeleteKey", () => {
  it("is Delete or Backspace, bare, outside any field", () => {
    expect(isDeleteKey(ev("Delete"))).toBe(true);
    expect(isDeleteKey(ev("Backspace"))).toBe(true);
    expect(isDeleteKey(ev("x"))).toBe(false);
    expect(isDeleteKey(ev("Backspace", null, { metaKey: true }))).toBe(false);
  });
  it("never fires while typing", () => {
    expect(isDeleteKey(ev("Backspace", { tagName: "TEXTAREA" }))).toBe(false);
    expect(isDeleteKey(ev("Delete", { tagName: "INPUT" }))).toBe(false);
    expect(isDeleteKey(ev("Backspace", { tagName: "DIV", isContentEditable: true }))).toBe(false);
  });
});

describe("isUndoKey", () => {
  const uev = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}, target: Partial<HTMLElement> | null = null) =>
    ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: target as EventTarget | null, ...mods });

  it("is Cmd-Z or Ctrl-Z, and nothing else", () => {
    expect(isUndoKey(uev("z", { metaKey: true }))).toBe(true);
    expect(isUndoKey(uev("z", { ctrlKey: true }))).toBe(true);
    expect(isUndoKey(uev("Z", { metaKey: true }))).toBe(true);
    expect(isUndoKey(uev("z"))).toBe(false);
    expect(isUndoKey(uev("z", { metaKey: true, shiftKey: true }))).toBe(false);
    expect(isUndoKey(uev("z", { metaKey: true, altKey: true }))).toBe(false);
    expect(isUndoKey(uev("y", { ctrlKey: true }))).toBe(false);
  });

  it("leaves the undo to the field while typing", () => {
    expect(isUndoKey(uev("z", { metaKey: true }, { tagName: "TEXTAREA" }))).toBe(false);
    expect(isUndoKey(uev("z", { metaKey: true }, { tagName: "DIV", isContentEditable: true }))).toBe(false);
  });
});

describe("listStep", () => {
  const base = { metaKey: false, ctrlKey: false, altKey: false, defaultPrevented: false, target: null };
  it("walks down on j or ArrowDown and up on k or ArrowUp", async () => {
    const { listStep } = await import("../lib/keys");
    expect(listStep({ ...base, key: "j" })).toBe(1);
    expect(listStep({ ...base, key: "ArrowDown" })).toBe(1);
    expect(listStep({ ...base, key: "k" })).toBe(-1);
    expect(listStep({ ...base, key: "ArrowUp" })).toBe(-1);
    expect(listStep({ ...base, key: "x" })).toBe(0);
  });
  it("stays out of a field, a modifier, and a key something else took", async () => {
    const { listStep } = await import("../lib/keys");
    expect(listStep({ ...base, key: "j", metaKey: true })).toBe(0);
    expect(listStep({ ...base, key: "ArrowDown", defaultPrevented: true })).toBe(0);
    expect(listStep({ ...base, key: "j", target: { tagName: "TEXTAREA", isContentEditable: false } as unknown as EventTarget })).toBe(0);
  });
});


describe("isHideKey", () => {
  it("is the = key, or + with Shift, outside a field", () => {
    expect(isHideKey(ev("="))).toBe(true);
    expect(isHideKey(ev("+", null, { shiftKey: true }))).toBe(true);
    expect(isHideKey(ev("=", null, { metaKey: true }))).toBe(false);
    expect(isHideKey(ev("=", { tagName: "TEXTAREA" }))).toBe(false);
    expect(isHideKey(ev("-"))).toBe(false);
  });
});

describe("nextThreadRow", () => {
  const rows = (sel: number) => ["t1", "t1", "t1", "t2", "t3"].map((threadId, i) => ({ threadId, selected: i === sel }));
  it("steps to the next thread, past the rows of the same one", () => {
    expect(nextThreadRow(rows(0), 1)?.threadId).toBe("t2");
    expect(nextThreadRow(rows(3), 1)?.threadId).toBe("t3");
    expect(nextThreadRow(rows(3), -1)?.threadId).toBe("t1");
    expect(nextThreadRow(rows(4), 1)).toBeNull();
    expect(nextThreadRow(rows(-1), 1)?.threadId).toBe("t1");
    expect(nextThreadRow(rows(-1), -1)?.threadId).toBe("t3");
  });
});
