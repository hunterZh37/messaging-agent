import { MODELS } from "../config";
import { createAnthropicProvider } from "../models/anthropic";
import type { ChatClient } from "./types";

/**
 * Ask Celeste on Claude, kept for callers that name the provider themselves.
 * Everything that reads config should go through `createChatClient(cfg)`
 * instead (spec 12).
 */
export function createAnthropicChatClient(apiKey?: string, model: string = MODELS.chat): ChatClient {
  return createAnthropicProvider(apiKey, model).chat();
}
