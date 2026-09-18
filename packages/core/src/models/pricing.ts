import { type ModelRef, type ModelUsage } from "./types";

export interface ModelPrice {
  /** US dollars per million input tokens. */
  inputPerMTok: number;
  /** US dollars per million output tokens. */
  outputPerMTok: number;
}

/**
 * Anthropic list prices, in one table so the eval report can put a number on
 * a run. These are ESTIMATES copied by hand on 2026-09-09 and nothing keeps
 * them current: read them as an order of magnitude, not a bill. A model with
 * no row here costs an unknown amount, which the report says plainly.
 * Ollama runs on the operator's own Mac, so it costs nothing per token.
 */
export const ANTHROPIC_PRICES: Record<string, ModelPrice> = {
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
};

/**
 * What Anthropic charges for the prompt cache, as a multiple of the input
 * price: a read is a tenth, and writing an entry costs a quarter more than
 * sending the same tokens uncached. Copied by hand with the prices above.
 */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_MULTIPLIER = 1.25;

/** What a token count would have cost, or null when the price is not known. */
export function estimateCostUsd(ref: ModelRef, usage: ModelUsage): number | null {
  if (ref.provider === "ollama") return 0;
  const price = ANTHROPIC_PRICES[ref.model];
  if (!price) return null;
  const input =
    usage.inputTokens +
    (usage.cacheReadTokens ?? 0) * CACHE_READ_MULTIPLIER +
    (usage.cacheWriteTokens ?? 0) * CACHE_WRITE_MULTIPLIER;
  return (input * price.inputPerMTok + usage.outputTokens * price.outputPerMTok) / 1_000_000;
}
