import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { ChatClient, ChatRequest, ChatResponse } from "../../src/chat/types";
import { modelCalls } from "../../src/db/schema";
import { withLedger } from "../../src/models/ledger";
import { estimateCostUsd } from "../../src/models/pricing";
import type { ModelProvider, ModelRef, ModelUsage, StructuredRequest, StructuredResult, TextRequest, TextResult } from "../../src/models/types";
import { testDb } from "../helpers/db";

const HAIKU: ModelRef = { provider: "anthropic", model: "claude-haiku-4-5" };
const LOCAL: ModelRef = { provider: "ollama", model: "qwen3:8b" };

/** A provider that answers with the usage the test names, or throws. */
function fakeProvider(ref: ModelRef, answer: { usage?: ModelUsage; throws?: string; chat?: ChatResponse[] } = {}): ModelProvider {
  const usage = answer.usage ?? { inputTokens: 100, outputTokens: 20 };
  const chatScript = [...(answer.chat ?? [])];
  return {
    ref,
    async structured<T>(_req: StructuredRequest<T>): Promise<StructuredResult<T>> {
      if (answer.throws) throw new Error(answer.throws);
      return { output: {} as T, usage, latencyMs: 42 };
    },
    async text(_req: TextRequest): Promise<TextResult> {
      if (answer.throws) throw new Error(answer.throws);
      return { text: "ok", usage, latencyMs: 42 };
    },
    chat(): ChatClient {
      return {
        model: "fake",
        async create(_request: ChatRequest): Promise<ChatResponse> {
          if (answer.throws) throw new Error(answer.throws);
          const next = chatScript.shift();
          if (!next) throw new Error("no scripted chat response");
          return next;
        },
      };
    },
  };
}

const REQUEST: StructuredRequest<unknown> = {
  system: [{ text: "you sort mail" }],
  messages: [{ role: "user", content: "this one?" }],
  schema: z.object({}),
  maxTokens: 100,
};

const CHAT_REQUEST: ChatRequest = { system: [], messages: [{ role: "user", content: "hi" }], tools: [], max_tokens: 100 };

function rows(db: ReturnType<typeof testDb>) {
  return db.select().from(modelCalls).all();
}

describe("withLedger", () => {
  it("writes one row for a structured call, with the role, the model and the cost", async () => {
    const db = testDb();
    const provider = withLedger(fakeProvider(HAIKU), db, { role: "sorter", accountId: "acc-1", ref: "msg-1" });

    await provider.structured(REQUEST);

    const [row] = rows(db);
    expect(row).toMatchObject({
      role: "sorter",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      kind: "structured",
      inputTokens: 100,
      outputTokens: 20,
      latencyMs: 42,
      accountId: "acc-1",
      ref: "msg-1",
      error: null,
    });
    // 100 input at $1/MTok plus 20 output at $5/MTok.
    expect(row?.costUsd).toBeCloseTo(0.0002, 10);
  });

  it("keeps the row when the call throws, with no tokens and the reason", async () => {
    const db = testDb();
    const provider = withLedger(fakeProvider(HAIKU, { throws: "overloaded" }), db, { role: "drafter" });

    await expect(provider.text({ system: [], messages: [], maxTokens: 10 })).rejects.toThrow("overloaded");

    const [row] = rows(db);
    expect(row).toMatchObject({ role: "drafter", kind: "text", inputTokens: 0, outputTokens: 0, error: "overloaded" });
    expect(row?.costUsd).toBe(0);
  });

  it("prices a local model at nothing", async () => {
    const db = testDb();
    await withLedger(fakeProvider(LOCAL), db, { role: "sorter" }).structured(REQUEST);
    expect(rows(db)[0]).toMatchObject({ provider: "ollama", model: "qwen3:8b", costUsd: 0 });
  });

  it("leaves the cost unknown for a model with no price", async () => {
    const db = testDb();
    await withLedger(fakeProvider({ provider: "anthropic", model: "claude-future-9" }), db, { role: "chat" }).structured(REQUEST);
    expect(rows(db)[0]?.costUsd).toBeNull();
  });

  it("records the cache counts a call read and wrote", async () => {
    const db = testDb();
    const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 4000, cacheWriteTokens: 800 };
    await withLedger(fakeProvider(HAIKU, { usage }), db, { role: "sorter" }).structured(REQUEST);

    const [row] = rows(db);
    expect(row).toMatchObject({ cacheReadTokens: 4000, cacheWriteTokens: 800 });
    // 10 + 400 (reads at a tenth) + 1000 (writes at 1.25) input, 5 output.
    expect(row?.costUsd).toBeCloseTo((1410 * 1 + 5 * 5) / 1_000_000, 12);
  });

  it("logs one row per request the tool loop sends, not one per question", async () => {
    const db = testDb();
    const answer = (n: number): ChatResponse => ({
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      usage: { input_tokens: n, output_tokens: 1 },
    });
    const client = withLedger(fakeProvider(HAIKU, { chat: [answer(10), answer(20), answer(30)] }), db, { role: "chat", ref: "chat-1" }).chat();

    await client.create(CHAT_REQUEST);
    await client.create(CHAT_REQUEST);
    await client.create(CHAT_REQUEST);

    const all = rows(db);
    expect(all).toHaveLength(3);
    expect(all.map((r) => r.inputTokens)).toEqual([10, 20, 30]);
    expect(all.every((r) => r.kind === "chat" && r.role === "chat" && r.ref === "chat-1")).toBe(true);
  });

  it("carries the tool loop's cache counts through", async () => {
    const db = testDb();
    const response: ChatResponse = {
      content: [],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 },
    };
    await withLedger(fakeProvider(HAIKU, { chat: [response] }), db, { role: "chat" }).chat().create(CHAT_REQUEST);
    expect(rows(db)[0]).toMatchObject({ cacheReadTokens: 900, cacheWriteTokens: 100 });
  });

  it("hands the answer back unchanged", async () => {
    const db = testDb();
    const result = await withLedger(fakeProvider(HAIKU), db, { role: "sorter" }).text({ system: [], messages: [], maxTokens: 10 });
    expect(result.text).toBe("ok");
  });
});

describe("estimateCostUsd", () => {
  it("bills a cache read at a tenth of an input token and a write at a quarter more", () => {
    const plain = estimateCostUsd(HAIKU, { inputTokens: 1_000_000, outputTokens: 0 });
    const read = estimateCostUsd(HAIKU, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 });
    const write = estimateCostUsd(HAIKU, { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 });
    expect(plain).toBe(1);
    expect(read).toBeCloseTo(0.1, 10);
    expect(write).toBeCloseTo(1.25, 10);
  });

  it("charges nothing for a local model however many tokens it read", () => {
    expect(estimateCostUsd(LOCAL, { inputTokens: 99_000, outputTokens: 4_000, cacheReadTokens: 100 })).toBe(0);
  });
});
