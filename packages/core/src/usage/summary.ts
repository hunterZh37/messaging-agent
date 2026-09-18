import { and, desc, gte, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { modelCalls } from "../db/schema";

/**
 * What the ledger adds up to (spec 13, 2026-09-11). One read of `model_calls`
 * answers the whole Usage page: the totals, which models the money went to,
 * which jobs spent it, and the shape of it day by day.
 *
 * Every number here is the ledger's own, so the page and `celeste usage`
 * cannot disagree with each other or with the rows.
 */

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** Calls on a model nothing has a price for. They add nothing to `costUsd`, so the page can say so. */
  unpricedCalls: number;
}

export interface UsageByModel extends UsageTotals {
  provider: string;
  model: string;
  /** `provider:model`, the way config names it. */
  ref: string;
}

export interface UsageByRole extends UsageTotals {
  role: string;
}

export interface UsageByDay {
  /** `YYYY-MM-DD` in the operator's own day, which `tzOffsetMinutes` decides. */
  day: string;
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageSummary {
  totals: UsageTotals;
  byModel: UsageByModel[];
  byRole: UsageByRole[];
  byDay: UsageByDay[];
}

export interface UsageWindow {
  /** Epoch ms, inclusive. Absent means every call ever made. */
  since?: number;
  /** Epoch ms, exclusive. */
  until?: number;
  /**
   * How far the operator's clock is from UTC, the way `getTimezoneOffset`
   * says it backwards: a browser in New York sends 300, meaning five hours
   * behind. Days are grouped by that clock, because a bill run at eleven at
   * night belongs to the night it was run.
   */
  tzOffsetMinutes?: number;
}

/** Every count a group needs, in one place, so the three groupings stay identical. */
const AGGREGATES = {
  calls: sql<number>`count(*)`,
  inputTokens: sql<number>`coalesce(sum(${modelCalls.inputTokens}), 0)`,
  outputTokens: sql<number>`coalesce(sum(${modelCalls.outputTokens}), 0)`,
  cacheReadTokens: sql<number>`coalesce(sum(${modelCalls.cacheReadTokens}), 0)`,
  cacheWriteTokens: sql<number>`coalesce(sum(${modelCalls.cacheWriteTokens}), 0)`,
  costUsd: sql<number>`coalesce(sum(${modelCalls.costUsd}), 0)`,
  unpricedCalls: sql<number>`coalesce(sum(case when ${modelCalls.costUsd} is null then 1 else 0 end), 0)`,
};

const EMPTY: UsageTotals = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  unpricedCalls: 0,
};

export function usageSummary(db: Db, window: UsageWindow = {}): UsageSummary {
  const bounds = [
    ...(window.since === undefined ? [] : [gte(modelCalls.at, window.since)]),
    ...(window.until === undefined ? [] : [lt(modelCalls.at, window.until)]),
  ];
  const where = bounds.length > 0 ? and(...bounds) : undefined;
  // A minute west of UTC is a minute to subtract before asking which day it was.
  const shiftMs = -(window.tzOffsetMinutes ?? 0) * 60_000;
  const day = sql<string>`strftime('%Y-%m-%d', (${modelCalls.at} + ${shiftMs}) / 1000, 'unixepoch')`;

  const totals = db.select(AGGREGATES).from(modelCalls).where(where).get() ?? EMPTY;

  const byModel = db
    .select({ provider: modelCalls.provider, model: modelCalls.model, ...AGGREGATES })
    .from(modelCalls)
    .where(where)
    .groupBy(modelCalls.provider, modelCalls.model)
    .orderBy(desc(AGGREGATES.costUsd), desc(AGGREGATES.calls))
    .all()
    .map((r) => ({ ...r, ref: `${r.provider}:${r.model}` }));

  const byRole = db
    .select({ role: modelCalls.role, ...AGGREGATES })
    .from(modelCalls)
    .where(where)
    .groupBy(modelCalls.role)
    .orderBy(desc(AGGREGATES.costUsd), desc(AGGREGATES.calls))
    .all();

  const byDay = db
    .select({ day, calls: AGGREGATES.calls, costUsd: AGGREGATES.costUsd, inputTokens: AGGREGATES.inputTokens, outputTokens: AGGREGATES.outputTokens })
    .from(modelCalls)
    .where(where)
    .groupBy(day)
    .orderBy(day)
    .all();

  return { totals, byModel, byRole, byDay };
}
