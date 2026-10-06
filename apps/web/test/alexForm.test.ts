import { describe, it, expect } from "vitest";
import { buildAlexItem } from "../app/inbox/[threadId]/alexForm";

// "When I press Add to Alex, no matter which day I select, it always adds to
// today instead of the date that I have selected" (operator, 2026-10-06). The
// panel had two fields that each carried a date: the Day picker for an untimed
// actionable, and the Starts date-time for a timed one, initialised to today.
// Picking a day and then ticking "Give it a time" dropped the picked day.

const base = { title: "Circle back with Chris", minutes: 30 };
const localDay = (isoInstant: string) => {
  const d = new Date(isoInstant);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

describe("Add to Alex: the day the operator picked is the day the item lands on", () => {
  it("untimed actionable: the Day field", () => {
    const item = buildAlexItem({ ...base, kind: "actionable", timed: false, day: "2026-10-08", time: "09:30", start: "2026-10-06T09:30" });
    expect(typeof item).not.toBe("string");
    if (typeof item === "string") return;
    expect(item.kind === "actionable" && localDay(item.dayISO)).toBe("2026-10-08");
  });

  it("timed actionable: the Day field plus the clock, never today's date from the Starts field", () => {
    const item = buildAlexItem({ ...base, kind: "actionable", timed: true, day: "2026-10-08", time: "09:30", start: "2026-10-06T09:30" });
    if (typeof item === "string") throw new Error(item);
    if (item.kind !== "actionable") throw new Error("kind");
    expect(localDay(item.dayISO)).toBe("2026-10-08");
    expect(localDay(item.startISO!)).toBe("2026-10-08");
    expect(new Date(item.startISO!).getHours()).toBe(9);
    expect(new Date(item.startISO!).getMinutes()).toBe(30);
    expect(new Date(item.endISO!).getTime() - new Date(item.startISO!).getTime()).toBe(30 * 60_000);
  });

  it("event: the Starts field carries its own date", () => {
    const item = buildAlexItem({ ...base, kind: "event", timed: false, day: "2026-10-08", time: "09:30", start: "2026-10-09T14:00" });
    if (typeof item === "string") throw new Error(item);
    if (item.kind !== "event") throw new Error("kind");
    expect(localDay(item.startISO)).toBe("2026-10-09");
  });

  it("no title: says so", () => {
    expect(buildAlexItem({ ...base, title: "  ", kind: "actionable", timed: false, day: "2026-10-08", time: "09:30", start: "2026-10-06T09:30" })).toBe("Give it a title.");
  });

  it("a cleared day, time or start says so instead of throwing", () => {
    const f = { ...base, kind: "actionable" as const, timed: true, day: "2026-10-08", time: "09:30", start: "2026-10-06T09:30" };
    expect(buildAlexItem({ ...f, time: "" })).toBe("Give it a time.");
    expect(buildAlexItem({ ...f, day: "" })).toBe("Give it a day.");
    expect(buildAlexItem({ ...f, timed: false, day: "" })).toBe("Give it a day.");
    expect(buildAlexItem({ ...f, kind: "event", start: "" })).toBe("Give it a start.");
  });
});
