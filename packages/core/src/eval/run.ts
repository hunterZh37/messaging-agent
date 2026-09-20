import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { readTextFile, type Config } from "../config";
import { now, type Db } from "../db/client";
import { evalResults, evalRuns, messages, sorts, type EvalRunRow } from "../db/schema";
import { providerFor } from "../models/factory";
import { withLedger } from "../models/ledger";
import { formatModelRef, type ModelProvider, type ModelRef, type ModelUsage } from "../models/types";
import { listCategories, OTHER, type Category } from "../sort/categories";
import { createOllamaEmbedder } from "../projects/embedder";
import { findExamples } from "../sort/examples";
import { readRules } from "../sort/rules";
import { sortSchemaFor, sortSystemBlocks, renderSortUserMessage, type SorterAids } from "../sort/sorter";
import type { SortInput, SortProject, SortResult } from "../sort/types";
import { assignedProjectName, listProjects } from "../projects/projects";

/**
 * Replaying stored mail through two models to see where they disagree
 * (spec 13). An eval reads the mailbox and writes only to its own tables:
 * `sorts` is what the operator lives with, and nothing here touches it.
 */

/** The verdict already in `sorts`, kept beside the candidates under this name. */
export const BASELINE = "baseline";

/**
 * A sorter that also says what the call cost. The `Sorter` seam answers with
 * a verdict alone, which is all the app needs and less than a comparison
 * needs, so the harness holds this slightly wider shape.
 */
export interface EvalSorter {
  readonly model: string;
  sort(
    criteria: string,
    categories: Category[],
    projects: SortProject[],
    input: SortInput,
  ): Promise<{ output: SortResult; usage: ModelUsage; latencyMs: number }>;
}

/**
 * The real thing: the sorter's own prompt, on whichever model the ref names,
 * with whichever learning aids the run is measuring. An aid that throws here
 * is left to throw — the run is asking what the aid is worth, and a silent
 * fallback would answer the wrong question.
 */
export function evalSorterFor(provider: ModelProvider, aids: SorterAids = {}, label?: string): EvalSorter {
  return {
    model: label ?? formatModelRef(provider.ref),
    async sort(criteria, categories, forProjects, input) {
      const examples = aids.examplesFor ? await aids.examplesFor(input) : [];
      const rules = aids.rules ? await aids.rules() : null;
      const { output, usage, latencyMs } = await provider.structured({
        system: sortSystemBlocks(criteria, categories, forProjects, rules),
        messages: [{ role: "user", content: renderSortUserMessage(input, examples) }],
        schema: sortSchemaFor(categories, forProjects),
        maxTokens: 1024,
      });
      return { output: output as SortResult, usage, latencyMs };
    },
  };
}

/**
 * What a model is called in the report when it was given an aid (spec 7a).
 * The same model bare and with examples are two things to compare, so they
 * need two names.
 */
export function evalModelLabel(ref: ModelRef, aids: { examples?: boolean; rules?: boolean } = {}): string {
  return `${formatModelRef(ref)}${aids.examples ? "+examples" : ""}${aids.rules ? "+rules" : ""}`;
}

export interface SortEvalOptions {
  models: ModelRef[];
  /** How many messages to replay. Fewer are used when the mailbox has fewer. */
  sample: number;
  accountId?: string;
  /** Fixes which messages are drawn, so a run can be repeated exactly. */
  seed?: number;
  /** The operator's criteria. Read from their criteria file when absent. */
  criteria?: string;
  /**
   * Give every model in the run the nearest trusted verdicts as worked
   * examples (spec 7a). Applied to all of them, because the run is measuring
   * the aid and not the model.
   */
  examples?: boolean;
  /** Give every model in the run the distilled rules file. */
  rules?: boolean;
  /** Test seam: how a ref and the run's aids become a sorter. */
  sorterFor?: (ref: ModelRef, aids: SorterAids) => EvalSorter;
  clock?: () => number;
}

export interface SortEvalRunResult {
  runId: string;
  sampled: number;
  /** Calls that answered. */
  answered: number;
  /** Calls that threw; each one is stored as an error row. */
  failed: number;
}

/** Deterministic and cheap, so the same seed draws the same mail twice. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], seed: number): T[] {
  const out = [...items];
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Runs every model over the same sample of already-sorted mail. Each answer
 * is stored with its latency and tokens; a call that throws becomes an error
 * row, because one unreachable model should not throw away the other's work.
 */
export async function runSortEval(db: Db, cfg: Config, opts: SortEvalOptions): Promise<SortEvalRunResult> {
  const clock = opts.clock ?? now;
  const criteria = opts.criteria ?? (await readTextFile(cfg.criteriaPath));

  // Only mail the operator has a verdict for: without one there is nothing
  // to be right or wrong about.
  const conditions = [eq(messages.isFromOperator, false), eq(messages.folder, "inbox")];
  if (opts.accountId) conditions.push(eq(messages.accountId, opts.accountId));
  const candidates = db
    .select({ m: messages, s: sorts })
    .from(messages)
    .innerJoin(sorts, eq(sorts.messageId, messages.id))
    .where(and(...conditions))
    .orderBy(messages.sentAt)
    .all();

  const chosen = shuffled(candidates, opts.seed ?? clock()).slice(0, Math.max(0, opts.sample));
  const runId = randomUUID();
  db.insert(evalRuns)
    .values({
      id: runId,
      role: "sorter",
      models: opts.models.map((ref) => evalModelLabel(ref, opts)),
      sampleSize: chosen.length,
      accountId: opts.accountId ?? null,
      startedAt: clock(),
      finishedAt: null,
    })
    .run();

  for (const row of chosen) {
    db.insert(evalResults)
      .values({
        id: randomUUID(),
        runId,
        messageId: row.m.id,
        model: BASELINE,
        output: {
          wants: row.s.wants,
          scheduling: row.s.scheduling,
          category: row.s.category ?? OTHER,
          finance: row.s.finance as SortResult["finance"],
          project: assignedProjectName(db, row.m.id),
          reason: row.s.reason,
        },
        latencyMs: null,
        inputTokens: null,
        outputTokens: null,
        error: null,
      })
      .run();
  }

  const categories: Category[] = listCategories(db).map((c) => ({ name: c.name, description: c.description }));
  const projectCache = new Map<string, SortProject[]>();
  const projectsFor = (accountId: string): SortProject[] => {
    const cached = projectCache.get(accountId);
    if (cached) return cached;
    const rows = listProjects(db, accountId).map((p) => ({ name: p.name, description: p.description }));
    projectCache.set(accountId, rows);
    return rows;
  };

  const aids = evalAids(db, cfg, opts);
  // An eval is real spending, so it lands in the usage ledger under its own
  // role with the run it belongs to (spec 13, 2026-09-11).
  const sorterFor =
    opts.sorterFor ??
    ((ref: ModelRef, forRun: SorterAids) =>
      evalSorterFor(withLedger(providerFor(ref, cfg), db, { role: "eval", ref: runId }), forRun, evalModelLabel(ref, opts)));
  let answered = 0;
  let failed = 0;

  for (const ref of opts.models) {
    const label = evalModelLabel(ref, opts);
    const sorter = sorterFor(ref, aids);
    for (const row of chosen) {
      const input: SortInput = {
        // The example lookup needs both, and it excludes the message it is
        // looking for examples for.
        id: row.m.id,
        accountId: row.m.accountId,
        fromAddress: row.m.fromAddress,
        fromName: row.m.fromName,
        subject: row.m.subject,
        bodyText: row.m.bodyText,
        attachmentNames: row.m.attachmentNames,
        sentAt: row.m.sentAt,
      };
      const values = { id: randomUUID(), runId, messageId: row.m.id, model: label };
      try {
        const r = await sorter.sort(criteria, categories, projectsFor(row.m.accountId), input);
        db.insert(evalResults)
          .values({ ...values, output: r.output, latencyMs: r.latencyMs, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, error: null })
          .run();
        answered++;
      } catch (err) {
        db.insert(evalResults)
          .values({ ...values, output: null, latencyMs: null, inputTokens: null, outputTokens: null, error: (err as Error).message })
          .run();
        failed++;
      }
    }
  }

  db.update(evalRuns).set({ finishedAt: clock() }).where(eq(evalRuns.id, runId)).run();
  return { runId, sampled: chosen.length, answered, failed };
}

/** The aids the run asked for, built once and handed to every model in it. */
function evalAids(db: Db, cfg: Config, opts: SortEvalOptions): SorterAids {
  const aids: SorterAids = {};
  if (opts.examples) {
    const trickleModel = formatModelRef(cfg.models.sorter);
    const embedder = createOllamaEmbedder(cfg.ollamaUrl, cfg.embedModel, { db });
    aids.examplesFor = async (input) => {
      if (!input.id || !input.accountId) return [];
      const { id, accountId } = input;
      return findExamples(db, embedder, { ...input, id, accountId }, { trickleModel });
    };
  }
  if (opts.rules) aids.rules = () => readRules(cfg);
  return aids;
}

/** Runs newest first, so `celeste eval report` can name the last one. */
export function listEvalRuns(db: Db, limit = 20): EvalRunRow[] {
  return db.select().from(evalRuns).orderBy(desc(evalRuns.startedAt)).limit(limit).all();
}
