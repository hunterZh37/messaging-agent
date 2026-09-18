import { describe, it, expect } from "vitest";
import type { Db } from "../../src/db/client";
import { modelCalls } from "../../src/db/schema";
import { renderUsageReport } from "../../src/usage/report";
import { usageSummary } from "../../src/usage/summary";
import { testDb } from "../helpers/db";

/** A call, with everything a test does not care about already filled in. */
function call(db: Db, row: Partial<typeof modelCalls.$inferInsert> & { id: string; at: number }): void {
  db.insert(modelCalls)
    .values({
      role: "sorter",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      kind: "structured",
      inputTokens: 100,
      outputTokens: 20,
      latencyMs: 500,
      costUsd: 0.0002,
      ...row,
    })
    .run();
}

const DAY = 86_400_000;
/** 2026-09-10T12:00:00Z, a Thursday noon in UTC. */
const NOON = Date.UTC(2026, 8, 10, 12);

describe("usageSummary totals", () => {
  it("reads as nothing spent on an empty ledger", () => {
    const summary = usageSummary(testDb());
    expect(summary.totals).toMatchObject({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(summary.byModel).toEqual([]);
    expect(summary.byDay).toEqual([]);
  });

  it("adds up calls, tokens, cache and money", () => {
    const db = testDb();
    call(db, { id: "a", at: NOON, inputTokens: 100, outputTokens: 20, cacheReadTokens: 4000, costUsd: 0.001 });
    call(db, { id: "b", at: NOON + 1000, inputTokens: 50, outputTokens: 10, cacheWriteTokens: 900, costUsd: 0.002 });

    expect(usageSummary(db).totals).toMatchObject({
      calls: 2,
      inputTokens: 150,
      outputTokens: 30,
      cacheReadTokens: 4000,
      cacheWriteTokens: 900,
      unpricedCalls: 0,
    });
    expect(usageSummary(db).totals.costUsd).toBeCloseTo(0.003, 10);
  });

  it("counts a call with no known price without pretending it was free", () => {
    const db = testDb();
    call(db, { id: "a", at: NOON, costUsd: 0.5 });
    call(db, { id: "b", at: NOON, model: "claude-future-9", costUsd: null });

    const { totals } = usageSummary(db);
    expect(totals).toMatchObject({ calls: 2, unpricedCalls: 1 });
    expect(totals.costUsd).toBeCloseTo(0.5, 10);
  });

  it("counts a failed call, tokens and all", () => {
    const db = testDb();
    call(db, { id: "a", at: NOON, inputTokens: 0, outputTokens: 0, costUsd: 0, error: "overloaded" });
    expect(usageSummary(db).totals).toMatchObject({ calls: 1, inputTokens: 0, costUsd: 0 });
  });
});

describe("usageSummary windows", () => {
  it("keeps only the calls inside since and until", () => {
    const db = testDb();
    call(db, { id: "old", at: NOON - 10 * DAY });
    call(db, { id: "in", at: NOON });
    call(db, { id: "later", at: NOON + 10 * DAY });

    expect(usageSummary(db, { since: NOON - DAY, until: NOON + DAY }).totals.calls).toBe(1);
    expect(usageSummary(db, { since: NOON - DAY }).totals.calls).toBe(2);
    expect(usageSummary(db).totals.calls).toBe(3);
  });

  it("takes since as inclusive and until as exclusive", () => {
    const db = testDb();
    call(db, { id: "at-since", at: NOON });
    call(db, { id: "at-until", at: NOON + DAY });
    expect(usageSummary(db, { since: NOON, until: NOON + DAY }).totals.calls).toBe(1);
  });
});

describe("usageSummary by model and by role", () => {
  it("groups by the model that answered, dearest first", () => {
    const db = testDb();
    call(db, { id: "a", at: NOON, model: "claude-haiku-4-5", costUsd: 0.01 });
    call(db, { id: "b", at: NOON, model: "claude-haiku-4-5", costUsd: 0.02 });
    call(db, { id: "c", at: NOON, provider: "ollama", model: "qwen3:8b", costUsd: 0, inputTokens: 7, outputTokens: 3 });

    const [first, second] = usageSummary(db).byModel;
    expect(first).toMatchObject({ ref: "anthropic:claude-haiku-4-5", calls: 2 });
    expect(first?.costUsd).toBeCloseTo(0.03, 10);
    expect(second).toMatchObject({ ref: "ollama:qwen3:8b", provider: "ollama", calls: 1, costUsd: 0, inputTokens: 7 });
  });

  it("groups by the job the call was for, not the model it used", () => {
    const db = testDb();
    call(db, { id: "a", at: NOON, role: "sorter" });
    call(db, { id: "b", at: NOON, role: "sorter_backlog" });
    call(db, { id: "c", at: NOON, role: "chat", costUsd: 0.5 });
    call(db, { id: "d", at: NOON, role: "embed", provider: "ollama", model: "nomic-embed-text", kind: "embed", inputTokens: 0, outputTokens: 0, costUsd: 0 });

    const byRole = usageSummary(db).byRole;
    expect(byRole.map((r) => r.role)).toEqual(["chat", "sorter", "sorter_backlog", "embed"]);
    expect(byRole.find((r) => r.role === "embed")).toMatchObject({ calls: 1, inputTokens: 0, costUsd: 0 });
  });
});

describe("usageSummary by day", () => {
  it("gives one row per day, oldest first", () => {
    const db = testDb();
    call(db, { id: "a", at: Date.UTC(2026, 8, 8, 9), costUsd: 0.01 });
    call(db, { id: "b", at: Date.UTC(2026, 8, 8, 23), costUsd: 0.02 });
    call(db, { id: "c", at: Date.UTC(2026, 8, 10, 1), costUsd: 0.04 });

    const byDay = usageSummary(db).byDay;
    expect(byDay.map((d) => d.day)).toEqual(["2026-09-08", "2026-09-10"]);
    expect(byDay[0]).toMatchObject({ calls: 2, inputTokens: 200, outputTokens: 40 });
    expect(byDay[0]?.costUsd).toBeCloseTo(0.03, 10);
  });

  it("puts a late-evening call on the operator's day, not UTC's", () => {
    const db = testDb();
    // 2026-09-10, 23:00 in New York, which is already the 11th in UTC.
    call(db, { id: "a", at: Date.UTC(2026, 8, 11, 3) });

    expect(usageSummary(db).byDay[0]?.day).toBe("2026-09-11");
    expect(usageSummary(db, { tzOffsetMinutes: 240 }).byDay[0]?.day).toBe("2026-09-10");
  });

  it("puts a small-hours call east of UTC on the right day too", () => {
    const db = testDb();
    // 2026-09-11, 08:00 in Singapore, which is still the 10th in UTC.
    call(db, { id: "a", at: Date.UTC(2026, 8, 11, 0) });
    expect(usageSummary(db, { tzOffsetMinutes: -480 }).byDay[0]?.day).toBe("2026-09-11");
  });
});

describe("renderUsageReport", () => {
  it("says so plainly when nothing was spent", () => {
    const text = renderUsageReport(usageSummary(testDb()), { window: "7d" });
    expect(text).toContain("Usage — the last 7 days");
    expect(text).toContain("No model calls in this window.");
  });

  it("prints the totals and a line per model, dearest first", () => {
    const db = testDb();
    call(db, { id: "a", at: NOON, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 4000, costUsd: 0.25 });
    call(db, { id: "b", at: NOON, provider: "ollama", model: "qwen3:8b", inputTokens: 10, outputTokens: 5, costUsd: 0 });

    const text = renderUsageReport(usageSummary(db), { window: "all" });
    expect(text).toContain("2 call(s) · 1,010 input · 205 output · 4,000 cache read");
    expect(text).toContain("$0.25 estimated");
    expect(text.indexOf("anthropic:claude-haiku-4-5")).toBeLessThan(text.indexOf("ollama:qwen3:8b"));
    expect(text).toContain("$0 local");
    expect(text).toContain("local models cost nothing");
  });

  it("says how many calls it could not price", () => {
    const db = testDb();
    call(db, { id: "a", at: NOON, model: "claude-future-9", costUsd: null });
    const text = renderUsageReport(usageSummary(db), { window: "30d" });
    expect(text).toContain("1 call(s) on a model with no known price");
    expect(text).toContain("unknown");
  });
});
