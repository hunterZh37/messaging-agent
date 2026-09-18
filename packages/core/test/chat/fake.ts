import type { ChatClient, ChatRequest, ChatResponse } from "../../src/chat/types";

/**
 * The model, scripted. Every request is kept so a test can assert what the
 * prompt was made of; no key, no network, no Anthropic anywhere near the
 * suite.
 */
export class FakeChatClient implements ChatClient {
  readonly model = "fake-model";
  readonly requests: ChatRequest[] = [];
  private readonly script: ChatResponse[];
  /** Runs on every request before the scripted answer, for prompt assertions. */
  inspect: ((request: ChatRequest) => void) | undefined;

  constructor(script: ChatResponse[]) {
    this.script = [...script];
  }

  async create(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(structuredClone(request));
    this.inspect?.(request);
    const next = this.script.shift();
    if (!next) throw new Error("FakeChatClient ran out of scripted responses");
    return next;
  }
}

export function textResponse(text: string): ChatResponse {
  return { content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } };
}

export function toolResponse(uses: { id: string; name: string; input: unknown }[]): ChatResponse {
  return {
    content: uses.map((u) => ({ type: "tool_use" as const, id: u.id, name: u.name, input: u.input })),
    stop_reason: "tool_use",
    usage: { input_tokens: 20, output_tokens: 8 },
  };
}
