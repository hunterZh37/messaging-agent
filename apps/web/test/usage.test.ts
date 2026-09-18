import { describe, it, expect } from "vitest";
import {
  barHeight,
  barWindow,
  dayKeyOf,
  fillDays,
  formatCount,
  formatDay,
  formatUsd,
  formatUsdFine,
  nextDay,
  usageSince,
  usageWindow,
} from "../app/usage/format";
import { conversationAboutLabel, conversationCostLabel, conversationTokensLabel, conversationUsageLabel } from "../lib/chat";

const DAY = 86_400_000;
/** 2026-09-10, noon local. */
const NOON = new Date(2026, 8, 10, 12, 0, 0, 0).getTime();

describe("usageWindow", () => {
  it("takes the window the link names", () => {
    expect(usageWindow("today")).toBe("today");
    expect(usageWindow("30d")).toBe("30d");
    expect(usageWindow("all")).toBe("all");
  });

  it("shows a week when the link says nothing, or something it does not know", () => {
    expect(usageWindow(undefined)).toBe("7d");
    expect(usageWindow("since-forever")).toBe("7d");
  });
});

describe("usageSince", () => {
  it("uses the same boundaries every other page does", () => {
    expect(usageSince("today", NOON)).toBe(new Date(2026, 8, 10, 0, 0, 0, 0).getTime());
    expect(usageSince("7d", NOON)).toBe(NOON - 7 * DAY);
    expect(usageSince("30d", NOON)).toBe(NOON - 30 * DAY);
  });

  it("has no lower bound at all for All", () => {
    expect(usageSince("all", NOON)).toBeNull();
  });
});

describe("the numbers on screen", () => {
  it("separates thousands", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1234567)).toBe("1,234,567");
  });

  it("gives money two decimals in the headline", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(1.5)).toBe("$1.50");
    expect(formatUsd(12.345)).toBe("$12.35");
  });

  it("gives a cell the digits a small bill needs, and says nothing is nothing", () => {
    expect(formatUsdFine(0)).toBe("$0");
    expect(formatUsdFine(0.0023)).toBe("$0.0023");
    expect(formatUsdFine(2.5)).toBe("$2.50");
  });

  it("reads a day out of its own string, not out of a clock", () => {
    expect(formatDay("2026-09-08")).toBe("Sep 8");
    expect(formatDay("2026-01-31")).toBe("Jan 31");
  });
});

describe("the bars", () => {
  it("scales to the busiest day and never hides a day that had something on it", () => {
    expect(barHeight(10, 10)).toBe(100);
    expect(barHeight(5, 10)).toBe(50);
    expect(barHeight(0.0001, 10)).toBe(4);
  });

  it("stands at nothing when the day had nothing, and when no day did", () => {
    expect(barHeight(0, 10)).toBe(0);
    expect(barHeight(0, 0)).toBe(0);
  });

  it("draws the last ninety days and counts the ones it left out", () => {
    const days = Array.from({ length: 100 }, (_, i) => i);
    const { bars, earlier } = barWindow(days);
    expect(bars).toHaveLength(90);
    expect(bars[0]).toBe(10);
    expect(earlier).toBe(10);
  });

  it("draws them all when there are fewer than ninety", () => {
    expect(barWindow([1, 2, 3])).toEqual({ bars: [1, 2, 3], earlier: 0 });
  });
});

describe("the days between", () => {
  it("steps over a month end without a timezone getting a say", () => {
    expect(nextDay("2026-09-30")).toBe("2026-10-01");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
  });

  it("names the operator's day, not UTC's", () => {
    // 2026-09-10, 23:00 in New York is already the 11th in UTC.
    expect(dayKeyOf(Date.UTC(2026, 8, 11, 3), 240)).toBe("2026-09-10");
    expect(dayKeyOf(Date.UTC(2026, 8, 11, 3), 0)).toBe("2026-09-11");
  });

  it("fills a quiet day in rather than leaving it out", () => {
    const rows = [{ day: "2026-09-08", calls: 3, costUsd: 0.1, inputTokens: 10, outputTokens: 2 }];
    const filled = fillDays(rows, "2026-09-07", "2026-09-09");
    expect(filled.map((d) => d.day)).toEqual(["2026-09-07", "2026-09-08", "2026-09-09"]);
    expect(filled[0]).toMatchObject({ calls: 0, costUsd: 0 });
    expect(filled[1]).toMatchObject({ calls: 3, costUsd: 0.1 });
  });

  it("gives one day back when the window is one day", () => {
    expect(fillDays([], "2026-09-10", "2026-09-10").map((d) => d.day)).toEqual(["2026-09-10"]);
  });
});

describe("what a conversation cost, as a label", () => {
  it("gives money two decimals, and says so when it is under a cent", () => {
    expect(conversationCostLabel(0.31)).toBe("$0.31");
    expect(conversationCostLabel(12)).toBe("$12.00");
    expect(conversationCostLabel(0.004)).toBe("<$0.01");
    expect(conversationCostLabel(0)).toBe("$0");
  });

  it("rounds tokens to what the operator can act on", () => {
    expect(conversationTokensLabel(1, 0)).toBe("1 token");
    expect(conversationTokensLabel(300, 112)).toBe("412 tokens");
    expect(conversationTokensLabel(40_000, 1000)).toBe("41k tokens");
    expect(conversationTokensLabel(1_150_000, 50_000)).toBe("1.2M tokens");
  });

  it("puts the two together under the conversation's name, approximately", () => {
    expect(conversationUsageLabel({ costUsd: 0.31, inputTokens: 40_000, outputTokens: 1000 })).toBe("≈ $0.31 · 41k tokens");
    expect(conversationUsageLabel({ costUsd: 0.0001, inputTokens: 900, outputTokens: 100 })).toBe("≈ <$0.01 · 1k tokens");
  });

  it("says nothing at all about a conversation nothing has been asked in", () => {
    expect(conversationUsageLabel(null)).toBeNull();
    expect(conversationUsageLabel({ costUsd: 0, inputTokens: 0, outputTokens: 0 })).toBeNull();
  });
});

describe("what a conversation is about, as a label", () => {
  it("leaves a thread's conversation under the name its mail gave it", () => {
    expect(conversationAboutLabel("Visa timeline · Victoria Chen", "when does it expire")).toBe("Visa timeline · Victoria Chen");
  });

  it("names a General conversation by the first thing asked in it", () => {
    expect(conversationAboutLabel("General", "why did Pear pass on us")).toBe("General · why did Pear pass on us");
  });

  it("cuts a long one where a row ends", () => {
    const label = conversationAboutLabel("General", "why did Pear pass on us and what did they say about the round");
    expect(label.endsWith("…")).toBe(true);
    expect(label.length).toBeLessThanOrEqual(60);
    expect(label.startsWith("General · why did Pear pass on us")).toBe(true);
  });

  it("keeps the whole of it when the caller asks for no cut", () => {
    const full = conversationAboutLabel("General", "why did Pear pass on us and what did they say about the round", Number.MAX_SAFE_INTEGER);
    expect(full).toBe("General · why did Pear pass on us and what did they say about the round");
  });

  it("falls back to the plain name when nothing has been asked", () => {
    expect(conversationAboutLabel("General", null)).toBe("General");
    expect(conversationAboutLabel(null, "anything")).toBe("Conversation");
  });

  it("puts a question typed over several lines on one", () => {
    expect(conversationAboutLabel("General", "  why did\n  Pear pass  ")).toBe("General · why did Pear pass");
  });
});
