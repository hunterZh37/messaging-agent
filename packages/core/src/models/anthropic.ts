import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ChatClient, ChatRequest, ChatResponse, ChatResponseBlock, ChatSystemBlock } from "../chat/types";
import {
  formatModelRef,
  ModelOutputError,
  type ModelProvider,
  type ModelUsage,
  type StructuredRequest,
  type StructuredResult,
  type SystemBlock,
  type TextRequest,
  type TextResult,
} from "./types";

/** The cache hint, spelled the way the API wants it. Ollama drops the same hint on the floor. */
export function toAnthropicSystem(blocks: SystemBlock[]): ChatSystemBlock[] {
  return blocks.map((b) =>
    b.cache ? ({ type: "text", text: b.text, cache_control: { type: "ephemeral" } } as const) : ({ type: "text", text: b.text } as const),
  );
}

/**
 * Anthropic counts cached input separately from fresh input, and the two are
 * billed at different rates, so the seam carries both rather than adding
 * them up (spec 13, 2026-09-11).
 */
function usageOf(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): ModelUsage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    ...(u.cache_read_input_tokens ? { cacheReadTokens: u.cache_read_input_tokens } : {}),
    ...(u.cache_creation_input_tokens ? { cacheWriteTokens: u.cache_creation_input_tokens } : {}),
  };
}

/**
 * Anthropic behind the seam (spec 12). This is the code the sorter, the
 * drafter and Ask Celeste used to hold themselves: structured output through
 * `zodOutputFormat`, cached system blocks, thinking off in the tool loop.
 * Nothing about the calls changed when they moved here.
 */
export function createAnthropicProvider(apiKey: string | undefined, model: string): ModelProvider {
  const client = new Anthropic(apiKey ? { apiKey } : {});
  const ref = { provider: "anthropic", model } as const;

  return {
    ref,

    async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
      const startedAt = Date.now();
      const response = await client.messages.parse({
        model,
        max_tokens: req.maxTokens,
        // Extended thinking stays off: it would spend the output budget
        // before a word of the answer is written.
        thinking: { type: "disabled" },
        system: toAnthropicSystem(req.system),
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        output_config: { format: zodOutputFormat(req.schema) },
      });
      if (!response.parsed_output) throw new ModelOutputError(`${model} returned unparseable output (stop_reason=${response.stop_reason})`);
      return { output: response.parsed_output as T, usage: usageOf(response.usage), latencyMs: Date.now() - startedAt };
    },

    async text(req: TextRequest): Promise<TextResult> {
      const startedAt = Date.now();
      const response = await client.messages.create({
        model,
        max_tokens: req.maxTokens,
        thinking: { type: "disabled" },
        system: toAnthropicSystem(req.system),
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      });
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
      if (!text) throw new ModelOutputError(`${model} returned no text (stop_reason=${response.stop_reason})`);
      return { text, usage: usageOf(response.usage), latencyMs: Date.now() - startedAt };
    },

    chat(): ChatClient {
      return {
        // The row says which model answered, provider and all (spec 12).
        model: formatModelRef(ref),
        async create(request: ChatRequest): Promise<ChatResponse> {
          // Extended thinking stays off. The answer is short and the tools
          // are cheap; a thinking budget would buy latency and nothing else.
          const response = await client.messages.create({
            model,
            max_tokens: request.max_tokens,
            thinking: { type: "disabled" },
            system: request.system,
            tools: request.tools,
            messages: request.messages as Anthropic.MessageParam[],
          });
          const content: ChatResponseBlock[] = [];
          for (const block of response.content) {
            if (block.type === "text") content.push({ type: "text", text: block.text });
            else if (block.type === "tool_use") content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
          }
          return {
            content,
            stop_reason: response.stop_reason,
            usage: {
              input_tokens: response.usage.input_tokens,
              output_tokens: response.usage.output_tokens,
              cache_read_input_tokens: response.usage.cache_read_input_tokens ?? undefined,
              cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? undefined,
            },
          };
        },
      };
    },
  };
}
