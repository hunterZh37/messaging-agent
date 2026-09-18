import { z } from "zod";
import type {
  ChatApiMessage,
  ChatClient,
  ChatRequest,
  ChatResponse,
  ChatResponseBlock,
  ChatSystemBlock,
  ChatToolDef,
} from "../chat/types";
import {
  formatModelRef,
  ModelOutputError,
  ModelUnavailableError,
  type ModelProvider,
  type ModelMessage,
  type ModelUsage,
  type StructuredRequest,
  type StructuredResult,
  type SystemBlock,
  type TextRequest,
  type TextResult,
} from "./types";

/**
 * A local model behind the same seam as Claude (spec 12). Nothing here
 * leaves the Mac: it talks to Ollama on the loopback address and no further.
 *
 * Two habits of local models are handled here rather than by the callers:
 * qwen3 narrates its reasoning into `content` unless thinking is turned off,
 * and a schema-constrained answer can still come back wrong, so a failed
 * parse is retried once with the validation error in hand.
 */

/** What Ollama's /api/chat accepts, narrowed to what is used. */
interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: { function: { name: string; arguments: unknown } }[];
  tool_name?: string;
}

interface OllamaResponse {
  message?: { role?: string; content?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[] };
  prompt_eval_count?: number;
  eval_count?: number;
}

/** The cache hint means nothing to a local model, so the blocks become one system turn. */
function systemTurn(blocks: SystemBlock[]): OllamaMessage[] {
  const text = blocks
    .map((b) => b.text)
    .filter((t) => t.trim() !== "")
    .join("\n\n");
  return text ? [{ role: "system", content: text }] : [];
}

function usageOf(body: OllamaResponse): ModelUsage {
  return { inputTokens: body.prompt_eval_count ?? 0, outputTokens: body.eval_count ?? 0 };
}

function contentOf(body: OllamaResponse): string {
  return body.message?.content ?? "";
}

/** Anthropic-style tool definitions, as Ollama spells them. */
export function toOllamaTools(tools: ChatToolDef[]): { type: "function"; function: { name: string; description: string; parameters: unknown } }[] {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
}

/**
 * The chat loop's messages, as Ollama turns: a tool call becomes an
 * assistant turn carrying `tool_calls`, and its result becomes a `tool`
 * turn. `askCeleste` keeps speaking Anthropic's dialect either way.
 */
export function toOllamaMessages(system: ChatSystemBlock[], messages: ChatApiMessage[]): OllamaMessage[] {
  const out: OllamaMessage[] = systemTurn(system.map((b) => ({ text: b.text })));
  // Ollama identifies a result by tool name, not by the id Anthropic hands out.
  const nameById = new Map<string, string>();

  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const text = m.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("");
    const calls = m.content.filter((b) => b.type === "tool_use") as { id: string; name: string; input: unknown }[];
    const results = m.content.filter((b) => b.type === "tool_result") as { tool_use_id: string; content: string }[];

    if (calls.length > 0 || (m.role === "assistant" && results.length === 0)) {
      for (const c of calls) nameById.set(c.id, c.name);
      const turn: OllamaMessage = { role: "assistant", content: text };
      if (calls.length > 0) turn.tool_calls = calls.map((c) => ({ function: { name: c.name, arguments: c.input ?? {} } }));
      out.push(turn);
    }
    for (const r of results) {
      const name = nameById.get(r.tool_use_id);
      out.push(name ? { role: "tool", content: r.content, tool_name: name } : { role: "tool", content: r.content });
    }
    if (results.length > 0 && text && m.role === "user") out.push({ role: "user", content: text });
  }
  return out;
}

export function createOllamaProvider(url: string, model: string): ModelProvider {
  const base = url.replace(/\/+$/, "");
  const endpoint = `${base}/api/chat`;
  let callCounter = 0;

  async function post(body: Record<string, unknown>): Promise<OllamaResponse> {
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // qwen3 emits its thinking into the answer unless this is off, and a
        // streamed answer would have to be reassembled for no gain here.
        body: JSON.stringify({ model, stream: false, think: false, ...body }),
      });
    } catch {
      // Connection refused is the everyday case: Ollama is not running,
      // which is a setup step rather than an error to report.
      throw new ModelUnavailableError(`Ollama is not running at ${url}`);
    }
    if (res.status === 404) throw new ModelUnavailableError(`Model ${model} is not pulled: ollama pull ${model}`);
    if (!res.ok) throw new ModelUnavailableError(`Ollama answered ${res.status} at ${url}`);
    return (await res.json()) as OllamaResponse;
  }

  function chatTurns(messages: ModelMessage[]): OllamaMessage[] {
    return messages.map((m) => ({ role: m.role, content: m.content }));
  }

  return {
    ref: { provider: "ollama", model },

    async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
      const startedAt = Date.now();
      const format = z.toJSONSchema(req.schema);
      const turns: OllamaMessage[] = [...systemTurn(req.system), ...chatTurns(req.messages)];
      const usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
      let lastError = "";

      // One retry, and only one: a model that cannot answer the schema twice
      // running will not answer it on the third try either.
      for (let attempt = 0; attempt < 2; attempt++) {
        const body = await post({ messages: turns, format, options: { temperature: 0, num_predict: req.maxTokens } });
        usage.inputTokens += usageOf(body).inputTokens;
        usage.outputTokens += usageOf(body).outputTokens;
        const raw = contentOf(body);

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          lastError = "The answer was not valid JSON.";
          turns.push({ role: "assistant", content: raw }, { role: "user", content: `${lastError} Answer again with JSON only, matching the schema.` });
          continue;
        }
        const result = req.schema.safeParse(parsed);
        if (result.success) return { output: result.data, usage, latencyMs: Date.now() - startedAt };

        lastError = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
        turns.push({ role: "assistant", content: raw }, { role: "user", content: `That answer did not fit the schema — ${lastError}. Answer again with JSON only.` });
      }
      throw new ModelOutputError(`${model} did not answer the schema after a retry: ${lastError}`);
    },

    async text(req: TextRequest): Promise<TextResult> {
      const startedAt = Date.now();
      const body = await post({
        messages: [...systemTurn(req.system), ...chatTurns(req.messages)],
        options: { num_predict: req.maxTokens },
      });
      const text = contentOf(body).trim();
      if (!text) throw new ModelOutputError(`${model} returned no text`);
      return { text, usage: usageOf(body), latencyMs: Date.now() - startedAt };
    },

    chat(): ChatClient {
      return {
        // The row says which model answered, provider and all (spec 12).
        model: formatModelRef({ provider: "ollama", model }),
        async create(request: ChatRequest): Promise<ChatResponse> {
          const body = await post({
            messages: toOllamaMessages(request.system, request.messages),
            tools: toOllamaTools(request.tools),
            options: { num_predict: request.max_tokens },
          });
          const content: ChatResponseBlock[] = [];
          const text = contentOf(body);
          if (text.trim() !== "") content.push({ type: "text", text });
          const calls = body.message?.tool_calls ?? [];
          for (const call of calls) {
            const name = call.function?.name;
            if (!name) continue;
            const args = call.function?.arguments;
            content.push({
              type: "tool_use",
              // Ollama names no call, and the loop matches a result to its
              // call by id, so the ids are minted here.
              id: `ollama_call_${++callCounter}`,
              name,
              input: typeof args === "string" ? safeJson(args) : (args ?? {}),
            });
          }
          return {
            content,
            // The loop keeps going only while the stop reason says a tool was called.
            stop_reason: calls.length > 0 ? "tool_use" : "end_turn",
            usage: { input_tokens: usageOf(body).inputTokens, output_tokens: usageOf(body).outputTokens },
          };
        },
      };
    },
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
