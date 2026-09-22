import type { Config, ModelRole } from "../config";
import type { Db } from "../db/client";
import { createDrafterFor } from "../draft/drafter";
import type { Drafter } from "../draft/types";
import { embedPending } from "../projects/classify";
import { createOllamaEmbedder } from "../projects/embedder";
import { findExamples } from "../sort/examples";
import { distillRules, MIN_TRUSTED_VERDICTS, readRules } from "../sort/rules";
import { createSorterFor } from "../sort/sorter";
import { withSenderRules } from "../sort/corrections";
import type { Sorter } from "../sort/types";
import type { ChatClient } from "../chat/types";
import { createAnthropicProvider } from "./anthropic";
import { createJevSorter } from "./jev";
import { withLedger, type LedgerContext } from "./ledger";
import { createOllamaProvider } from "./ollama";
import { formatModelRef, type ModelProvider, type ModelRef } from "./types";

/**
 * Which adapter answers for a ref. This is the only place that knows both
 * providers exist; every role above it holds a `ModelProvider` and cannot
 * tell which one it got (spec 12).
 */
export function providerFor(ref: ModelRef, cfg: Config): ModelProvider {
  switch (ref.provider) {
    case "ollama":
      return createOllamaProvider(cfg.ollamaUrl, ref.model);
    case "anthropic":
      return createAnthropicProvider(cfg.anthropicApiKey, ref.model);
    case "typesafe":
      // Jev answers typed questions rather than prompts, so it has no
      // ModelProvider to be: it is built straight into a sorter below.
      throw new Error(`${ref.model} is a sorter, not a prompt model: name it as the sorter role, not as ${formatModelRef(ref)} for another role.`);
  }
}

/**
 * The provider one role talks to. Hand it the database and every call it
 * makes is written to the usage ledger (spec 13): the wrapping happens here
 * so no caller has to remember to do it, and a job that borrows another
 * role's model — distilling rules, proposing projects — says which job it is
 * with `ctx.role`.
 */
export function providerForRole(role: ModelRole, cfg: Config, db?: Db, ctx: Partial<LedgerContext> = {}): ModelProvider {
  const provider = providerFor(cfg.models[role], cfg);
  return db ? withLedger(provider, db, { role, ...ctx }) : provider;
}

/**
 * Which of the two sorter roles a job wants (spec 7a). `trickle` is the
 * handful of messages that arrive between syncs; `backlog` is every bulk
 * job — a newly connected inbox, Sort older, Re-sort, the sort after a
 * backfill — where the operator is paying for a better model on purpose.
 */
export type SorterKind = "trickle" | "backlog";

/**
 * The trickle sorter with everything it learns from the backlog model
 * (spec 7a): the nearest trusted verdicts as worked examples, and the rules
 * distilled from all of them. Both are best-effort — the examples come from
 * a local embedder that may not be running, and the rules file may not exist
 * yet — and neither can stop a message being sorted.
 */
export function createLearningSorter(cfg: Config, db: Db): Sorter {
  const trickleModel = formatModelRef(cfg.models.sorter);
  const embedder = createOllamaEmbedder(cfg.ollamaUrl, cfg.embedModel, { db });

  // Mail that arrived since the last projects pass has no vector, and a
  // message with no vector has no neighbours to learn from. Once per inbox
  // per sorter, because a sorter is built per run.
  const embedding = new Map<string, Promise<void>>();
  const embedOnce = (accountId: string): Promise<void> => {
    let started = embedding.get(accountId);
    if (!started) {
      started = embedPending(db, embedder, { accountId })
        .then(() => undefined)
        .catch((err: Error) => {
          console.error(`embedding before sort failed for ${accountId}:`, err.message);
        });
      embedding.set(accountId, started);
    }
    return started;
  };

  return createSorterFor(providerForRole("sorter", cfg, db), {
    examplesFor: async (input) => {
      // A caller that only has the mail in hand, and not the row it came
      // from, cannot be given this inbox's precedents.
      if (!input.id || !input.accountId) return [];
      const { id, accountId } = input;
      await embedOnce(accountId);
      return findExamples(db, embedder, { ...input, id, accountId }, { trickleModel });
    },
    rules: () => readRules(cfg),
  });
}

/**
 * Jev, when the role names it (operator, 2026-09-21). It is built here rather
 * than behind `providerFor` because it is not a prompt model: it answers
 * typed questions and hands back numbers, so it is a Sorter from the start
 * and has no examples or rules to be given.
 */
function jevSorterFor(role: "sorter" | "sorter_backlog", cfg: Config, db: Db): Sorter | null {
  if (cfg.models[role].provider !== "typesafe") return null;
  if (!cfg.typesafeApiKey) throw new Error("the sorter is set to Jev but TYPESAFE_API_KEY is not set.");
  return createJevSorter({ apiKey: cfg.typesafeApiKey, ledger: { db, ctx: { role } } });
}

export function createSorter(cfg: Config, db: Db, kind: SorterKind = "trickle"): Sorter {
  const role = kind === "backlog" ? "sorter_backlog" : "sorter";
  const model =
    jevSorterFor(role, cfg, db) ??
    (kind === "backlog" ? createSorterFor(providerForRole("sorter_backlog", cfg, db)) : createLearningSorter(cfg, db));
  // The operator's standing instructions are read before any model is asked,
  // whichever model that is (operator, 2026-09-20).
  return withSenderRules(db, model);
}

/** The database is optional only so a caller with no database still builds; give it one and the drafting is counted. */
export function createDrafter(cfg: Config, db?: Db, ctx: Partial<LedgerContext> = {}): Drafter {
  return createDrafterFor(providerForRole("drafter", cfg, db, ctx));
}

export function createChatClient(cfg: Config, db?: Db, ctx: Partial<LedgerContext> = {}): ChatClient {
  return providerForRole("chat", cfg, db, ctx).chat();
}

/**
 * What every bulk sort does on its way out (spec 7a): the backlog model has
 * just judged a pile of mail, so the rules the trickle model reads are out
 * of date. Callers do not await this — the operator is waiting on the sort,
 * not on the rewrite — so it never throws, and a failure is a log line and
 * the rules the run started with.
 *
 * One at a time: "Sort older" runs in batches and the operator presses it
 * again while the last rewrite is still in flight, and two Sonnet calls
 * racing to rename the same file would buy nothing but the second bill.
 */
let distilling: Promise<void> | null = null;

export async function afterBacklogRun(
  db: Db,
  cfg: Config,
  opts: { accountId?: string; provider?: ModelProvider } = {},
): Promise<void> {
  if (distilling) return distilling;
  distilling = distillAfterBacklog(db, cfg, opts).finally(() => {
    distilling = null;
  });
  return distilling;
}

async function distillAfterBacklog(db: Db, cfg: Config, opts: { accountId?: string; provider?: ModelProvider }): Promise<void> {
  try {
    const provider = opts.provider ?? providerForRole("drafter", cfg, db, { role: "rules" });
    await distillRules(db, cfg, provider, {
      trickleModel: formatModelRef(cfg.models.sorter),
      minVerdicts: MIN_TRUSTED_VERDICTS,
      ...(opts.accountId ? { accountId: opts.accountId } : {}),
    });
  } catch (err) {
    console.error("distilling rules after the backlog run failed:", (err as Error).message);
  }
}
