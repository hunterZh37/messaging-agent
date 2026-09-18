// Relative, not aliased: the tests load this module on its own, without Next's resolver.
import { WINDOWS, type WindowKey } from "../../lib/selection";
import { windowStart } from "../inbox/shared";

/**
 * The Usage page's arithmetic, kept pure so a test can check the numbers on
 * screen without rendering anything (spec 13, 2026-09-11).
 */

/** The window the `?since=` param names. Nothing is remembered: usage is a page you visit, not a view you live in. */
export function usageWindow(param: string | undefined): WindowKey {
  return WINDOWS.find((w) => w === param) ?? "7d";
}

/** Epoch ms the window starts at, or null for all of it. The same boundaries every other page uses. */
export function usageSince(window: WindowKey, now: number = Date.now()): number | null {
  return windowStart(window, now);
}

/** 1234567 → "1,234,567". Tokens are counted in millions and read in thousands. */
export function formatCount(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** The headline number, always two decimals: this is money. */
export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/**
 * A cell in a table, where two decimals would round a real number to
 * nothing. Under a cent it gets the digits it needs, and exactly nothing
 * reads as "$0" rather than "$0.00".
 */
export function formatUsdFine(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "2026-09-08" → "Sep 8". Built from the string rather than a Date, so the
 * server and the browser read the same day out of it and nothing shifts
 * after mount.
 */
export function formatDay(day: string): string {
  const [, month, date] = day.split("-");
  const name = MONTHS[Number(month) - 1];
  if (!name || !date) return day;
  return `${name} ${Number(date)}`;
}

/** How tall one bar stands, as a percentage of the busiest day. A day with something on it is never invisible. */
export function barHeight(value: number, max: number): number {
  if (max <= 0 || value <= 0) return 0;
  return Math.max(4, Math.round((value / max) * 100));
}

/** The most bars the page draws. All time is still ninety days of them, and a line saying how many were left out. */
export const MAX_BARS = 90;

/** The last `MAX_BARS` days, and how many days were dropped off the front. */
export function barWindow<T>(days: T[], max: number = MAX_BARS): { bars: T[]; earlier: number } {
  if (days.length <= max) return { bars: days, earlier: 0 };
  return { bars: days.slice(days.length - max), earlier: days.length - max };
}

/** Which day an instant fell on, on the operator's clock. */
export function dayKeyOf(at: number, tzOffsetMinutes: number): string {
  return new Date(at - tzOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** The day after this one, done on the string so no clock and no timezone gets a say. */
export function nextDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + 1)).toISOString().slice(0, 10);
}

export interface DayRow {
  day: string;
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

const EMPTY_DAY = { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };

/**
 * Every day from `from` to `to`, with the ledger's rows dropped into place
 * and a nothing day where nothing was spent. A day off shows as a gap in the
 * bars rather than vanishing and making the week look busier than it was.
 */
export function fillDays(rows: DayRow[], from: string, to: string, limit = 400): DayRow[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out: DayRow[] = [];
  let day = from;
  for (let i = 0; i <= limit && day <= to; i++) {
    out.push(byDay.get(day) ?? { day, ...EMPTY_DAY });
    day = nextDay(day);
  }
  return out;
}
