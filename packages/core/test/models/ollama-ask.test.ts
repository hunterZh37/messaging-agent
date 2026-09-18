import { describe, it, expect, afterEach, vi } from "vitest";
import { testDb } from "../helpers/db";
import { seedMail } from "../chat/seed";
import { askCeleste } from "../../src/chat/ask";
import { getOrCreateChat } from "../../src/chat/store";
import { createOllamaProvider } from "../../src/models/ollama";

/**
 * The real Ask Celeste loop, on the Ollama adapter, with the tool definitions
 * `ask.ts` actually ships rather than a stand-in. This is what proves the
 * mapping both ways: the loop never learns which model answered it, and the
 * adapter never learns what the tools mean.
 */

const URL = "http://127.0.0.1:11434";

interface Sent {
  tools: { type: string; function: { name: string; description: string; parameters: unknown } }[];
  messages: { role: string; content: string; tool_calls?: { function: { name: string; arguments: unknown } }[]; tool_name?: string }[];
}

function ollamaReply(message: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ message, prompt_eval_count: 20, eval_count: 7 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function clockFrom(start: number): () => number {
  let t = start;
  return () => t++;
}

describe("askCeleste on the Ollama adapter", () => {
  it("carries the real tool definitions out and a tool result back", async () => {
    const db = testDb();
    seedMail(db, [{ id: "m1", subject: "March invoice", bodyText: "The invoice for March is due on the 30th." }]);
    const chat = getOrCreateChat(db);

    const sent: Sent[] = [];
    const script = [
      ollamaReply({ role: "assistant", content: "", tool_calls: [{ function: { name: "search_inbox", arguments: { query: "invoice" } } }] }),
      ollamaReply({ role: "assistant", content: "It is due on the 30th. [msg:a1:m1]" }),
    ];
    let i = 0;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(init.body as string) as Sent);
      const res = script[i++];
      if (!res) throw new Error(`no scripted response for call ${i}`);
      return res;
    });

    const turn = await askCeleste(
      db,
      { client: createOllamaProvider(URL, "qwen3:8b").chat(), clock: clockFrom(1000) },
      { chatId: chat.id, question: "When is the invoice due?", contextThreadId: null },
    );

    expect(turn.assistant.content).toContain("due on the 30th");
    expect(turn.assistant.model).toBe("ollama:qwen3:8b");
    // Usage is the whole exchange, both calls.
    expect(turn.assistant.inputTokens).toBe(40);

    // Every tool the loop offers survives the trip, schemas and all.
    expect(sent).toHaveLength(2);
    const names = sent[0]!.tools.map((t) => t.function.name);
    expect(names).toEqual(["list_mail", "search_inbox", "get_thread", "propose_action"]);
    expect(sent[0]!.tools.every((t) => t.type === "function")).toBe(true);
    // propose_action carries an array of thread ids; nothing flattens it.
    const propose = sent[0]!.tools.find((t) => t.function.name === "propose_action")!;
    expect((propose.function.parameters as { properties: { thread_ids: { type: string; items: unknown } } }).properties.thread_ids).toMatchObject({
      type: "array",
      items: { type: "string" },
    });

    // The second call replays the call as an assistant turn and its answer as
    // a tool turn, which is how Ollama expects to be reminded.
    const second = sent[1]!.messages;
    const call = second.find((m) => m.tool_calls);
    expect(call).toMatchObject({ role: "assistant", tool_calls: [{ function: { name: "search_inbox", arguments: { query: "invoice" } } }] });
    const result = second.find((m) => m.role === "tool")!;
    expect(result.tool_name).toBe("search_inbox");
    expect(result.content).toContain("a1:m1");
  });

  it("turns a proposal into a button, the same as on Claude", async () => {
    const db = testDb();
    seedMail(db, [{ id: "m1", threadId: "a1:t1", subject: "March invoice" }]);
    const chat = getOrCreateChat(db);

    const script = [
      ollamaReply({
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "propose_action", arguments: { kind: "draft_reply", thread_ids: ["a1:t1"], note: "they asked" } } }],
      }),
      ollamaReply({ role: "assistant", content: "Want me to reply?" }),
    ];
    let i = 0;
    vi.stubGlobal("fetch", async () => {
      const res = script[i++];
      if (!res) throw new Error("no scripted response");
      return res;
    });

    const turn = await askCeleste(
      db,
      { client: createOllamaProvider(URL, "qwen3:8b").chat(), clock: clockFrom(1000) },
      { chatId: chat.id, question: "Anything to answer?", contextThreadId: null },
    );

    expect(turn.actions).toEqual([{ kind: "draft_reply", threadIds: ["a1:t1"], note: "they asked", threads: [{ id: "a1:t1", subject: "March invoice", from: "Bob <bob@example.com>" }] }]);
  });
});
