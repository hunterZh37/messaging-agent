import type { UsageSummary } from "./summary";

/**
 * The ledger as `celeste usage` prints it (spec 13, 2026-09-11): the totals,
 * then a line per model. Same numbers as the page, because both read the
 * same summary.
 */

const WINDOW_TITLES: Record<string, string> = {
  today: "today",
  "7d": "the last 7 days",
  "30d": "the last 30 days",
  all: "all time",
};

function count(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function money(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function padLeft(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

export function renderUsageReport(summary: UsageSummary, opts: { window?: string } = {}): string {
  const { totals, byModel } = summary;
  const lines: string[] = [];
  lines.push(`Usage — ${WINDOW_TITLES[opts.window ?? "all"] ?? opts.window}`);
  lines.push("");

  if (totals.calls === 0) {
    lines.push("No model calls in this window.");
    return lines.join("\n");
  }

  const cache: string[] = [];
  if (totals.cacheReadTokens > 0) cache.push(`${count(totals.cacheReadTokens)} cache read`);
  if (totals.cacheWriteTokens > 0) cache.push(`${count(totals.cacheWriteTokens)} cache write`);
  lines.push(
    [`${count(totals.calls)} call(s)`, `${count(totals.inputTokens)} input`, `${count(totals.outputTokens)} output`, ...cache].join(" · "),
  );
  lines.push(`${money(totals.costUsd)} estimated`);
  if (totals.unpricedCalls > 0) lines.push(`${count(totals.unpricedCalls)} call(s) on a model with no known price, counted in nothing above.`);
  lines.push("");

  const nameWidth = Math.max(5, ...byModel.map((m) => m.ref.length));
  lines.push([padRight("model", nameWidth), padLeft("calls", 9), padLeft("input", 12), padLeft("output", 11), padLeft("cost", 10)].join("  "));
  for (const m of byModel) {
    lines.push(
      [
        padRight(m.ref, nameWidth),
        padLeft(count(m.calls), 9),
        padLeft(count(m.inputTokens), 12),
        padLeft(count(m.outputTokens), 11),
        padLeft(m.provider === "ollama" ? "$0 local" : m.unpricedCalls === m.calls ? "unknown" : money(m.costUsd), 10),
      ].join("  "),
    );
  }

  lines.push("");
  lines.push("Prices are Anthropic list prices, not a bill; local models cost nothing.");
  lines.push("Cache reads are billed at 10%, writes at 125%.");
  return lines.join("\n");
}
