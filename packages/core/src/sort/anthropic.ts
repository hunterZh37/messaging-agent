import { MODELS } from "../config";
import { createAnthropicProvider } from "../models/anthropic";
import { createSorterFor } from "./sorter";
import type { Sorter } from "./types";

/**
 * The sorter on Claude, kept for callers that name the provider themselves.
 * Everything that reads config should go through `createSorter(cfg)` instead
 * (spec 12), so a role can be moved to a local model from `.env`.
 */
export function createAnthropicSorter(apiKey?: string, model: string = MODELS.sorter): Sorter {
  return createSorterFor(createAnthropicProvider(apiKey, model));
}
