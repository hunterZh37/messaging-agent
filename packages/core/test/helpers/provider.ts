import type { ChatClient } from "../../src/chat/types";
import type { ModelProvider, ModelRef, StructuredRequest, StructuredResult, TextRequest, TextResult } from "../../src/models/types";

/**
 * A provider that answers whatever the test tells it to and keeps every
 * request, so a test can read the prompt a role built without a model
 * anywhere near the suite.
 */
export class FakeProvider implements ModelProvider {
  readonly ref: ModelRef;
  readonly structuredRequests: StructuredRequest<unknown>[] = [];
  readonly textRequests: TextRequest[] = [];

  constructor(
    ref: ModelRef,
    private readonly answers: { structured?: unknown; text?: string } = {},
  ) {
    this.ref = ref;
  }

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.structuredRequests.push(req as StructuredRequest<unknown>);
    return { output: this.answers.structured as T, usage: { inputTokens: 100, outputTokens: 20 }, latencyMs: 5 };
  }

  async text(req: TextRequest): Promise<TextResult> {
    this.textRequests.push(req);
    return { text: this.answers.text ?? "", usage: { inputTokens: 100, outputTokens: 20 }, latencyMs: 5 };
  }

  chat(): ChatClient {
    throw new Error("FakeProvider has no chat loop");
  }

  /** The system blocks of the last structured call, as plain text. */
  lastSystem(): string[] {
    return (this.structuredRequests.at(-1)?.system ?? []).map((b) => b.text);
  }

  /** The user message of the last structured call. */
  lastUser(): string {
    return this.structuredRequests.at(-1)?.messages.at(-1)?.content ?? "";
  }
}
