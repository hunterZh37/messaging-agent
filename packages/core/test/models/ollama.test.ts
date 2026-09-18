import { describe, it, expect, afterEach, vi } from "vitest";
import { z } from "zod";
import { createOllamaProvider } from "../../src/models/ollama";
import { ModelOutputError, ModelUnavailableError } from "../../src/models/types";
import type { ChatRequest } from "../../src/chat/types";

const URL = "http://127.0.0.1:11434";
const MODEL = "qwen3:8b";

const Verdict = z.object({ important: z.boolean(), reason: z.string() });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function reply(content: string, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({ message: { role: "assistant", content }, prompt_eval_count: 11, eval_count: 3, ...extra });
}

interface Sent {
  url: string;
  body: {
    model: string;
    stream: boolean;
    think: boolean;
    format?: unknown;
    tools?: unknown[];
    options?: { temperature?: number };
    messages: { role: string; content: string; tool_calls?: unknown[]; tool_name?: string }[];
  };
}

/** Answers each call from the script in order, keeping what was sent. */
function stubFetch(script: Response[]): Sent[] {
  const sent: Sent[] = [];
  let i = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(init.body as string) as Sent["body"] });
    const res = script[i++];
    if (!res) throw new Error(`no scripted response for call ${i}`);
    return res;
  });
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createOllamaProvider.structured", () => {
  it("posts /api/chat with thinking off, the schema as format, and temperature 0", async () => {
    const sent = stubFetch([reply(JSON.stringify({ important: true, reason: "rent is due" }))]);

    const result = await createOllamaProvider(URL, MODEL).structured({
      system: [{ text: "triage", cache: true }, { text: "criteria" }],
      messages: [{ role: "user", content: "From: bob" }],
      schema: Verdict,
      maxTokens: 1024,
    });

    expect(sent[0]!.url).toBe(`${URL}/api/chat`);
    expect(sent[0]!.body.model).toBe(MODEL);
    expect(sent[0]!.body.stream).toBe(false);
    // qwen3 narrates its reasoning into `content` unless this is off.
    expect(sent[0]!.body.think).toBe(false);
    expect(sent[0]!.body.options?.temperature).toBe(0);
    expect(sent[0]!.body.format).toEqual(z.toJSONSchema(Verdict));
    // The cache hint means nothing here, so the blocks arrive as one system turn.
    expect(sent[0]!.body.messages).toEqual([
      { role: "system", content: "triage\n\ncriteria" },
      { role: "user", content: "From: bob" },
    ]);

    expect(result.output).toEqual({ important: true, reason: "rent is due" });
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 3 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("retries once with the validation error when the answer does not fit the schema", async () => {
    const sent = stubFetch([
      reply(JSON.stringify({ important: "yes", reason: "rent is due" })),
      reply(JSON.stringify({ important: true, reason: "rent is due" })),
    ]);

    const result = await createOllamaProvider(URL, MODEL).structured({
      system: [{ text: "triage" }],
      messages: [{ role: "user", content: "From: bob" }],
      schema: Verdict,
      maxTokens: 1024,
    });

    expect(result.output).toEqual({ important: true, reason: "rent is due" });
    expect(sent).toHaveLength(2);
    const retry = sent[1]!.body.messages;
    expect(retry.at(-2)).toEqual({ role: "assistant", content: JSON.stringify({ important: "yes", reason: "rent is due" }) });
    expect(retry.at(-1)!.role).toBe("user");
    expect(retry.at(-1)!.content).toContain("important");
    // Both calls are counted: the retry is not free.
    expect(result.usage.inputTokens).toBe(22);
  });

  it("gives up with ModelOutputError after the retry also fails", async () => {
    stubFetch([reply("not json at all"), reply("still not json")]);
    await expect(
      createOllamaProvider(URL, MODEL).structured({
        system: [],
        messages: [{ role: "user", content: "hi" }],
        schema: Verdict,
        maxTokens: 256,
      }),
    ).rejects.toBeInstanceOf(ModelOutputError);
  });
});

describe("createOllamaProvider.text", () => {
  it("returns the trimmed content and asks for no format", async () => {
    const sent = stubFetch([reply("  Thanks, that works for me.  ")]);
    const result = await createOllamaProvider(URL, MODEL).text({
      system: [{ text: "rules", cache: true }],
      messages: [{ role: "user", content: "draft this" }],
      maxTokens: 4096,
    });
    expect(result.text).toBe("Thanks, that works for me.");
    expect(sent[0]!.body.format).toBeUndefined();
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 3 });
  });

  it("refuses an empty answer", async () => {
    stubFetch([reply("   ")]);
    await expect(
      createOllamaProvider(URL, MODEL).text({ system: [], messages: [{ role: "user", content: "x" }], maxTokens: 10 }),
    ).rejects.toBeInstanceOf(ModelOutputError);
  });
});

const CHAT_REQUEST: ChatRequest = {
  system: [{ type: "text", text: "you are Celeste", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: "anything new?" }],
  tools: [
    {
      name: "list_mail",
      description: "what is in the mailbox",
      input_schema: { type: "object", properties: { since: { type: "string" } }, required: [] },
    },
  ],
  max_tokens: 4096,
};

describe("createOllamaProvider.chat", () => {
  it("maps tool definitions out and tool calls back, so the ask loop is untouched", async () => {
    const sent = stubFetch([
      reply("", { message: { role: "assistant", content: "", tool_calls: [{ function: { name: "list_mail", arguments: { since: "7d" } } }] } }),
    ]);

    const response = await createOllamaProvider(URL, MODEL).chat().create(CHAT_REQUEST);

    expect(sent[0]!.body.tools).toEqual([
      {
        type: "function",
        function: { name: "list_mail", description: "what is in the mailbox", parameters: { type: "object", properties: { since: { type: "string" } }, required: [] } },
      },
    ]);
    expect(sent[0]!.body.messages).toEqual([
      { role: "system", content: "you are Celeste" },
      { role: "user", content: "anything new?" },
    ]);
    expect(response.content).toEqual([{ type: "tool_use", id: expect.any(String), name: "list_mail", input: { since: "7d" } }]);
    // The loop only keeps going while the stop reason says a tool was called.
    expect(response.stop_reason).toBe("tool_use");
  });

  it("sends tool results back as tool turns and an assistant turn carrying the call", async () => {
    const sent = stubFetch([reply("Two things came in.")]);
    const client = createOllamaProvider(URL, MODEL).chat();

    const response = await client.create({
      ...CHAT_REQUEST,
      messages: [
        { role: "user", content: "anything new?" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "list_mail", input: { since: "7d" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "2 messages" }] },
      ],
    });

    expect(sent[0]!.body.messages).toEqual([
      { role: "system", content: "you are Celeste" },
      { role: "user", content: "anything new?" },
      { role: "assistant", content: "", tool_calls: [{ function: { name: "list_mail", arguments: { since: "7d" } } }] },
      { role: "tool", content: "2 messages", tool_name: "list_mail" },
    ]);
    expect(response.content).toEqual([{ type: "text", text: "Two things came in." }]);
    expect(response.stop_reason).toBe("end_turn");
    expect(response.usage).toEqual({ input_tokens: 11, output_tokens: 3 });
  });

  it("gives each tool call its own id", async () => {
    stubFetch([
      reply("", {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { function: { name: "list_mail", arguments: {} } },
            { function: { name: "search_inbox", arguments: { query: "invoice" } } },
          ],
        },
      }),
    ]);
    const response = await createOllamaProvider(URL, MODEL).chat().create(CHAT_REQUEST);
    const ids = response.content.map((b) => (b.type === "tool_use" ? b.id : ""));
    expect(new Set(ids).size).toBe(2);
  });
});

describe("createOllamaProvider errors", () => {
  it("names the fix when Ollama is not running", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      createOllamaProvider(URL, MODEL).text({ system: [], messages: [{ role: "user", content: "x" }], maxTokens: 10 }),
    ).rejects.toThrow(new ModelUnavailableError(`Ollama is not running at ${URL}`));
  });

  it("names the pull command when the model is missing", async () => {
    stubFetch([jsonResponse({ error: `model "${MODEL}" not found` }, 404)]);
    await expect(
      createOllamaProvider(URL, MODEL).text({ system: [], messages: [{ role: "user", content: "x" }], maxTokens: 10 }),
    ).rejects.toThrow(new ModelUnavailableError(`Model ${MODEL} is not pulled: ollama pull ${MODEL}`));
  });

  it("reports any other status", async () => {
    stubFetch([jsonResponse({ error: "boom" }, 500)]);
    await expect(
      createOllamaProvider(URL, MODEL).text({ system: [], messages: [{ role: "user", content: "x" }], maxTokens: 10 }),
    ).rejects.toBeInstanceOf(ModelUnavailableError);
  });
});
