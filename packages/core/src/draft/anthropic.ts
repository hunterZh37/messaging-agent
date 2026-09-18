import { MODELS } from "../config";
import { createAnthropicProvider } from "../models/anthropic";
import { createDrafterFor } from "./drafter";
import type { Drafter } from "./types";

/**
 * The drafter on Claude, kept for callers that name the provider themselves.
 * Everything that reads config should go through `createDrafter(cfg)`
 * instead (spec 12).
 */
export function createAnthropicDrafter(apiKey?: string, model: string = MODELS.drafter): Drafter {
  return createDrafterFor(createAnthropicProvider(apiKey, model));
}
