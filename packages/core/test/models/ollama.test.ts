import { describe, it, expect, afterEach, vi } from "vitest";
import { z } from "zod";
import { createOllamaProvider, ollamaChatBusy } from "../../src/models/ollama";
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

/** One deferred per call, in call order, so a test can settle each independently. */
function deferredFetch(): { resolve: (res: Response) => void; reject: (err: unknown) => void }[] {
  const pending: { resolve: (res: Response) => void; reject: (err: unknown) => void }[] = [];
  vi.stubGlobal(
    "fetch",
    () =>
      new Promise<Response>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
  return pending;
}

const textCall = (content: string) => createOllamaProvider(URL, MODEL).text({ system: [], messages: [{ role: "user", content }], maxTokens: 10 });

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

/**
 * Module-level across every provider instance (2026-10-07, fix round 2):
 * every sorter/drafter/ask caller goes through this file's one `post()`, so
 * this is what `apps/web`'s `localModelBusy()` actually reads — not a
 * per-call-site flag that a new caller could forget to set.
 */
describe("ollamaChatBusy", () => {
  it("is busy while a chat call is in flight, and clears once it resolves", async () => {
    let resolve!: (res: Response) => void;
    vi.stubGlobal("fetch", () => new Promise<Response>((r) => (resolve = r)));

    expect(ollamaChatBusy()).toBe(false);
    const p = createOllamaProvider(URL, MODEL).text({ system: [], messages: [{ role: "user", content: "x" }], maxTokens: 10 });
    // `post()` reaches `fetch()` synchronously, before yielding back here —
    // no microtask wait needed before resolving it.
    expect(ollamaChatBusy()).toBe(true);
    resolve(reply("hi"));
    await p;
    expect(ollamaChatBusy()).toBe(false);
  });

  it("clears even when the call throws, so a dead Ollama can't wedge it on forever", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const p = createOllamaProvider(URL, MODEL).text({ system: [], messages: [{ role: "user", content: "x" }], maxTokens: 10 });
    expect(ollamaChatBusy()).toBe(true);
    await expect(p).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(ollamaChatBusy()).toBe(false);
  });

  /**
   * The whole point of a counter rather than a boolean: a single in-flight
   * call finishing must not clear it while another is still on the wire. A
   * sort makes many model calls, and the mail clock's own trickle sort can
   * overlap a manual Re-sort or a revise — exactly the case a boolean would
   * get wrong, by reading not-busy the moment either call settled.
   */
  it("stays busy while a second overlapping call is still in flight, and only clears once both finish", async () => {
    const pending = deferredFetch();

    const a = textCall("a");
    const b = textCall("b");
    expect(ollamaChatBusy()).toBe(true);

    pending[0]!.resolve(reply("a"));
    await a;
    expect(ollamaChatBusy()).toBe(true); // b is still in flight

    pending[1]!.resolve(reply("b"));
    await b;
    expect(ollamaChatBusy()).toBe(false);

    // A later call reads busy correctly — if the pair above had left the
    // count negative instead of exactly zero, this would read false while
    // c is still in flight.
    const c = textCall("c");
    expect(ollamaChatBusy()).toBe(true);
    pending[2]!.resolve(reply("c"));
    await c;
    expect(ollamaChatBusy()).toBe(false);
  });

  it("stays busy while a second overlapping call is still in flight after the first throws, and reaches exactly zero rather than negative", async () => {
    const pending = deferredFetch();

    const a = textCall("a");
    const b = textCall("b");

    pending[0]!.reject(new TypeError("fetch failed"));
    await expect(a).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(ollamaChatBusy()).toBe(true); // b is still in flight, a's throw didn't double-decrement

    pending[1]!.resolve(reply("b"));
    await b;
    expect(ollamaChatBusy()).toBe(false);

    const c = textCall("c");
    expect(ollamaChatBusy()).toBe(true);
    pending[2]!.resolve(reply("c"));
    await c;
    expect(ollamaChatBusy()).toBe(false);
  });
});
