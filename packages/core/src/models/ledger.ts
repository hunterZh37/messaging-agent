import { randomUUID } from "node:crypto";
import type { ChatClient, ChatRequest, ChatResponse } from "../chat/types";
import type { Db } from "../db/client";
import { modelCalls } from "../db/schema";
import { estimateCostUsd } from "./pricing";
import {
  type ModelProvider,
  type ModelRef,
  type ModelUsage,
  type StructuredRequest,
  type StructuredResult,
  type TextRequest,
  type TextResult,
} from "./types";

/**
 * The usage ledger (spec 13, 2026-09-11). Every model call any role makes
 * goes through the `ModelProvider` seam, so wrapping a provider once is
 * enough to know what the whole app spent: tokens, models and money, with
 * nothing to keep in sync at the call sites.
 *
 * Writing the row can never cost the operator the answer they were waiting
 * for, so a failed insert is a log line and nothing more.
 */

/**
 * Which job the call was for. The first five are the model roles config
 * names; the rest are jobs that borrow the drafter's model, and `embed` is
 * the local embedder.
 */
export const USAGE_ROLES = ["sorter", "sorter_backlog", "drafter", "chat", "stats", "rules", "propose", "eval", "embed"] as const;
export type UsageRole = (typeof USAGE_ROLES)[number];

/** What each role is called where the operator can see it. */
export const USAGE_ROLE_LABELS: Record<UsageRole, string> = {
  sorter: "Sorting (trickle)",
  sorter_backlog: "Sorting (backlog)",
  drafter: "Drafting",
  chat: "Ask Celeste",
  stats: "Reading your tone",
  rules: "Distilling rules",
  propose: "Proposing projects",
  eval: "Eval runs",
  embed: "Embeddings",
};

export type ModelCallKind = "structured" | "text" | "chat" | "embed";

/** What the call was for, fixed when the provider is built. */
export interface LedgerContext {
  role: UsageRole;
  accountId?: string;
  /** Whatever the work was about: a message id, a draft id, a chat id, an eval run id. */
  ref?: string;
}

export interface LedgerEntry extends LedgerContext {
  modelRef: ModelRef;
  kind: ModelCallKind;
  usage: ModelUsage;
  latencyMs: number;
  /** Set when the call threw; the row is kept with no tokens on it. */
  error?: string;
  at?: number;
}

/** One row, or a log line if the row will not go in. Never throws. */
export function recordModelCall(db: Db, entry: LedgerEntry): void {
  try {
    db.insert(modelCalls)
      .values({
        id: randomUUID(),
        at: entry.at ?? Date.now(),
        role: entry.role,
        provider: entry.modelRef.provider,
        model: entry.modelRef.model,
        kind: entry.kind,
        inputTokens: entry.usage.inputTokens,
        outputTokens: entry.usage.outputTokens,
        cacheReadTokens: entry.usage.cacheReadTokens ?? null,
        cacheWriteTokens: entry.usage.cacheWriteTokens ?? null,
        latencyMs: entry.latencyMs,
        costUsd: estimateCostUsd(entry.modelRef, entry.usage),
        accountId: entry.accountId ?? null,
        ref: entry.ref ?? null,
        error: entry.error ?? null,
      })
      .run();
  } catch (err) {
    console.error("could not record a model call:", (err as Error).message);
  }
}

const NO_TOKENS: ModelUsage = { inputTokens: 0, outputTokens: 0 };

/**
 * The same provider, with every call it answers written down. The tool loop
 * logs one row per request it sends, not one per question asked, because
 * one question can be eight requests and the bill is for all eight.
 */
export function withLedger(provider: ModelProvider, db: Db, ctx: LedgerContext): ModelProvider {
  const log = (kind: ModelCallKind, usage: ModelUsage, latencyMs: number, error?: string): void => {
    recordModelCall(db, { ...ctx, modelRef: provider.ref, kind, usage, latencyMs, ...(error ? { error } : {}) });
  };

  return {
    ref: provider.ref,

    async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
      const startedAt = Date.now();
      try {
        const result = await provider.structured(req);
        log("structured", result.usage, result.latencyMs);
        return result;
      } catch (err) {
        log("structured", NO_TOKENS, Date.now() - startedAt, (err as Error).message);
        throw err;
      }
    },

    async text(req: TextRequest): Promise<TextResult> {
      const startedAt = Date.now();
      try {
        const result = await provider.text(req);
        log("text", result.usage, result.latencyMs);
        return result;
      } catch (err) {
        log("text", NO_TOKENS, Date.now() - startedAt, (err as Error).message);
        throw err;
      }
    },

    chat(): ChatClient {
      const client = provider.chat();
      return {
        model: client.model,
        async create(request: ChatRequest): Promise<ChatResponse> {
          const startedAt = Date.now();
          try {
            const response = await client.create(request);
            log("chat", chatUsage(response), Date.now() - startedAt);
            return response;
          } catch (err) {
            log("chat", NO_TOKENS, Date.now() - startedAt, (err as Error).message);
            throw err;
          }
        },
      };
    },
  };
}

/** The tool loop's dialect of a token count, in the seam's own words. */
function chatUsage(response: ChatResponse): ModelUsage {
  const u = response.usage;
  if (!u) return NO_TOKENS;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    ...(u.cache_read_input_tokens ? { cacheReadTokens: u.cache_read_input_tokens } : {}),
    ...(u.cache_creation_input_tokens ? { cacheWriteTokens: u.cache_creation_input_tokens } : {}),
  };
}
