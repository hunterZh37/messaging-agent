import type { z } from "zod";
import type { ChatClient } from "../chat/types";

/**
 * The model seam (spec 12, amended 2026-09-10). Every role — sorter,
 * drafter, chat — names its model as `provider:model`, so a local model can
 * stand in for a Claude one without touching the code that calls it.
 *
 * This module imports nothing but types, so config, the adapters and the
 * eval harness can all lean on it without a cycle.
 */

export const MODEL_PROVIDERS = ["anthropic", "ollama", "typesafe"] as const;
export type ModelProviderName = (typeof MODEL_PROVIDERS)[number];

export interface ModelRef {
  provider: ModelProviderName;
  model: string;
}

function isProviderName(s: string): s is ModelProviderName {
  return (MODEL_PROVIDERS as readonly string[]).includes(s);
}

/**
 * `ollama:qwen3:8b` → `{ ollama, "qwen3:8b" }`. The split is on the FIRST
 * colon because an Ollama tag carries one of its own, and a name whose
 * prefix is not a provider is an Anthropic model, colons and all.
 */
export function parseModelRef(ref: string): ModelRef {
  const s = ref.trim();
  if (!s) throw new Error("Model ref is empty");
  const colon = s.indexOf(":");
  if (colon > 0) {
    const head = s.slice(0, colon);
    if (isProviderName(head)) {
      const model = s.slice(colon + 1).trim();
      if (!model) throw new Error(`Model ref "${s}" names a provider with no model`);
      return { provider: head, model };
    }
  }
  return { provider: "anthropic", model: s };
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}:${ref.model}`;
}

/** Ollama is not running, or the model is not pulled. Always a setup step, never a bug. */
export class ModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

/** The model answered, but not in the shape that was asked for. */
export class ModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelOutputError";
  }
}

/**
 * A system block, and whether it is worth caching. Anthropic marks it
 * ephemeral; Ollama has no prompt cache to address, so it ignores the hint
 * and joins the blocks.
 */
export interface SystemBlock {
  text: string;
  cache?: boolean;
}

export interface ModelMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * Anthropic's prompt cache, which the sorter and the chat loop lean on
   * heavily (spec 13, 2026-09-11). A cached read is billed at a tenth of an
   * input token and writing the cache at a quarter more, so the two cannot
   * be folded into `inputTokens` without overstating the bill. Absent on
   * every local model, which has no cache to address.
   */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface StructuredRequest<T> {
  system: SystemBlock[];
  messages: ModelMessage[];
  schema: z.ZodType<T>;
  maxTokens: number;
}

export interface StructuredResult<T> {
  output: T;
  usage: ModelUsage;
  latencyMs: number;
}

export interface TextRequest {
  system: SystemBlock[];
  messages: ModelMessage[];
  maxTokens: number;
}

export interface TextResult {
  text: string;
  usage: ModelUsage;
  latencyMs: number;
}

/**
 * What every role talks to. Three shapes, because that is all Celeste asks
 * of a model: a JSON verdict, a paragraph, and a tool loop.
 */
export interface ModelProvider {
  readonly ref: ModelRef;
  structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
  text(req: TextRequest): Promise<TextResult>;
  /** The tool-loop contract `askCeleste` already uses. */
  chat(): ChatClient;
}
