import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { evalResults, evalRuns } from "../db/schema";
import { estimateCostUsd } from "../models/pricing";
import { parseModelRef } from "../models/types";
import type { SortResult } from "../sort/types";
import { BASELINE } from "./run";

/**
 * What a finished run says (spec 13). Agreement is a fraction of the
 * messages both sides answered, never a fraction of the sample: a model that
 * failed on half the mail should not look half as good as one that answered.
 */

/** The fields a sort verdict is scored on. Reason is prose, so it is not one of them. */
export const SCORED_FIELDS = ["wants", "scheduling", "finance", "category", "project"] as const;
export type ScoredField = (typeof SCORED_FIELDS)[number];

export type Agreement = Record<ScoredField, number>;

export interface SortEvalModelReport {
  model: string;
  /** Messages this model answered. */
  answered: number;
  errors: number;
  /** Messages scored against the baseline: answered, and with a baseline to compare to. */
  compared: number;
  agreement: Agreement;
  meanLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  /** Null when no list price is known for the model. Ollama is 0. */
  estimatedCostUsd: number | null;
}

export interface PairwiseAgreement {
  a: string;
  b: string;
  compared: number;
  agreement: Agreement;
}

export interface SortEvalReport {
  runId: string;
  role: string;
  sampleSize: number;
  startedAt: number;
  finishedAt: number | null;
  models: SortEvalModelReport[];
  pairwise: PairwiseAgreement[];
}

/**
 * A verdict's scored fields, with the category read the way the app reads
 * it: a message that is not important has no sub-category, so two models
 * that both call it unimportant agree about its category whatever they named.
 */
function scored(v: SortResult): Record<ScoredField, string> {
  return {
    wants: v.wants,
    scheduling: String(v.scheduling),
    finance: v.finance,
    // Mail bound for the bin carries no sub-category, so two models that both
    // bin a message agree about its category whatever they named.
    category: v.wants === "bin" ? "" : v.category,
    project: v.project,
  };
}

function agreementBetween(pairs: [SortResult, SortResult][]): Agreement {
  const out = {} as Agreement;
  for (const field of SCORED_FIELDS) {
    if (pairs.length === 0) {
      out[field] = 0;
      continue;
    }
    const hits = pairs.filter(([a, b]) => scored(a)[field] === scored(b)[field]).length;
    out[field] = hits / pairs.length;
  }
  return out;
}

export function sortEvalReport(db: Db, runId: string): SortEvalReport {
  const run = db.select().from(evalRuns).where(eq(evalRuns.id, runId)).get();
  if (!run) throw new Error(`No eval run ${runId}`);
  const rows = db.select().from(evalResults).where(eq(evalResults.runId, runId)).all();

  const byModel = new Map<string, Map<string, (typeof rows)[number]>>();
  for (const row of rows) {
    let m = byModel.get(row.model);
    if (!m) byModel.set(row.model, (m = new Map()));
    m.set(row.messageId, row);
  }
  const baseline = byModel.get(BASELINE) ?? new Map();

  const models: SortEvalModelReport[] = run.models.map((model) => {
    const mine = byModel.get(model) ?? new Map();
    const answers = [...mine.values()].filter((r) => r.output !== null);
    const pairs: [SortResult, SortResult][] = [];
    for (const r of answers) {
      const base = baseline.get(r.messageId);
      if (base?.output) pairs.push([base.output, r.output!]);
    }
    const latencies = answers.map((r) => r.latencyMs ?? 0);
    const inputTokens = answers.reduce((n, r) => n + (r.inputTokens ?? 0), 0);
    const outputTokens = answers.reduce((n, r) => n + (r.outputTokens ?? 0), 0);
    return {
      model,
      answered: answers.length,
      errors: [...mine.values()].filter((r) => r.error !== null).length,
      compared: pairs.length,
      agreement: agreementBetween(pairs),
      meanLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
      inputTokens,
      outputTokens,
      // A model that ran with an aid is labelled `<ref>+examples`; the price
      // list knows the model, not the label.
      estimatedCostUsd: estimateCostUsd(parseModelRef(model.split("+")[0]!), { inputTokens, outputTokens }),
    };
  });

  const pairwise: PairwiseAgreement[] = [];
  for (let i = 0; i < run.models.length; i++) {
    for (let j = i + 1; j < run.models.length; j++) {
      const a = run.models[i]!;
      const b = run.models[j]!;
      const left = byModel.get(a) ?? new Map();
      const right = byModel.get(b) ?? new Map();
      const pairs: [SortResult, SortResult][] = [];
      for (const [messageId, row] of left) {
        const other = right.get(messageId);
        if (row.output && other?.output) pairs.push([row.output, other.output]);
      }
      pairwise.push({ a, b, compared: pairs.length, agreement: agreementBetween(pairs) });
    }
  }

  return {
    runId: run.id,
    role: run.role,
    sampleSize: run.sampleSize,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    models,
    pairwise,
  };
}

/** A dash, not 0%: nothing to compare is not the same as never agreeing. */
function pct(n: number, compared: number): string {
  return compared === 0 ? "—" : `${(n * 100).toFixed(0)}%`;
}

function money(n: number | null): string {
  return n === null ? "unknown" : `$${n.toFixed(4)}`;
}

/** Left-pads to a width, so the columns line up in a terminal. */
function pad(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/** The report as a table, for `celeste eval report`. */
export function renderSortEvalReport(report: SortEvalReport): string {
  const lines: string[] = [];
  lines.push(`Eval ${report.runId} — ${report.role}, ${report.sampleSize} messages`);
  lines.push("");
  lines.push("Agreement with the verdict already stored (higher is closer to today's behaviour):");
  lines.push("");

  const nameWidth = Math.max(5, ...report.models.map((m) => m.model.length));
  const cols = SCORED_FIELDS;
  const header = [padRight("model", nameWidth), ...cols.map((c) => pad(c, 11)), pad("latency", 9), pad("tokens", 12), pad("cost", 10)].join("  ");
  lines.push(header);
  for (const m of report.models) {
    lines.push(
      [
        padRight(m.model, nameWidth),
        ...cols.map((c) => pad(pct(m.agreement[c], m.compared), 11)),
        pad(`${m.meanLatencyMs}ms`, 9),
        pad(`${m.inputTokens}/${m.outputTokens}`, 12),
        pad(money(m.estimatedCostUsd), 10),
      ].join("  "),
    );
  }

  const withErrors = report.models.filter((m) => m.errors > 0);
  if (withErrors.length > 0) {
    lines.push("");
    for (const m of withErrors) lines.push(`${m.model}: ${m.errors} call(s) failed, ${m.answered} answered`);
  }

  if (report.pairwise.length > 0) {
    lines.push("");
    lines.push("Agreement between models:");
    lines.push("");
    for (const p of report.pairwise) {
      const parts = cols.map((c) => `${c} ${pct(p.agreement[c], p.compared)}`).join(", ");
      lines.push(`${p.a} vs ${p.b} (${p.compared} messages): ${parts}`);
    }
  }

  lines.push("");
  lines.push("Cost is an estimate from list prices, not a bill. Local models are free.");
  return lines.join("\n");
}
