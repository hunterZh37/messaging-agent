/**
 * The four ranges the stats page offers. They live here rather than in the
 * page because the warmer computes the same four ahead of time, and a warmer
 * that disagreed with the page about what "12 months" means would fill the
 * cache with entries nothing ever reads.
 */
export const RANGES = [
  { key: "all", label: "All time", days: null },
  { key: "year", label: "This year", days: null },
  { key: "12m", label: "12 months", days: 365 },
  { key: "90d", label: "90 days", days: 90 },
] as const;

export type RangeKey = (typeof RANGES)[number]["key"];

export function sinceFor(key: RangeKey): number | null {
  if (key === "all") return null;
  if (key === "year") return new Date(new Date().getFullYear(), 0, 1).getTime();
  const days = RANGES.find((r) => r.key === key)?.days;
  return days ? Date.now() - days * 86_400_000 : null;
}

/** The range a query string asked for, or All time when it named nothing real. */
export function rangeKeyFrom(range: string | undefined): RangeKey {
  return (RANGES.find((r) => r.key === range)?.key ?? "all") as RangeKey;
}
