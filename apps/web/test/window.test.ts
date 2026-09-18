import { describe, it, expect } from "vitest";
import { windowStart } from "../app/inbox/shared";
import { selectedWindow } from "../lib/selection";

const NOON = new Date(2026, 8, 7, 12, 30, 0).getTime();
const DAY = 86_400_000;

describe("selectedWindow", () => {
  it("reads the four windows and falls back to Today", () => {
    expect(selectedWindow("today", undefined)).toBe("today");
    expect(selectedWindow("7d", undefined)).toBe("7d");
    expect(selectedWindow("30d", undefined)).toBe("30d");
    expect(selectedWindow("all", undefined)).toBe("all");
    expect(selectedWindow(undefined, undefined)).toBe("today");
    expect(selectedWindow("last-year", undefined)).toBe("today");
  });
});

describe("windowStart", () => {
  it("starts Today at local midnight", () => {
    expect(windowStart("today", NOON)).toBe(new Date(2026, 8, 7, 0, 0, 0, 0).getTime());
  });

  it("counts 7 and 30 days back from now", () => {
    expect(windowStart("7d", NOON)).toBe(NOON - 7 * DAY);
    expect(windowStart("30d", NOON)).toBe(NOON - 30 * DAY);
  });

  it("has no lower bound for All", () => {
    expect(windowStart("all", NOON)).toBeNull();
  });
});
