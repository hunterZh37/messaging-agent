import { describe, it, expect } from "vitest";
import { explainMessage } from "../../src/chat/explain";
import type { ModelProvider, TextRequest } from "../../src/models/types";

/** A provider that answers with whatever the test names, and records the ask. */
function providerSaying(text: string): { provider: ModelProvider; asked: TextRequest[] } {
  const asked: TextRequest[] = [];
  const provider = {
    ref: { vendor: "fake", model: "fake" },
    structured: async () => {
      throw new Error("not used");
    },
    chat: () => {
      throw new Error("not used");
    },
    text: async (req: TextRequest) => {
      asked.push(req);
      return { text, usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 };
    },
  } as unknown as ModelProvider;
  return { provider, asked };
}

describe("explainMessage", () => {
  const message = { subject: "Workforce training budget", from: "Keith <keith@example.com>", sentAt: 0, bodyText: "I need your sign-off before Friday." };

  it("answers in one sentence about what the message is about", async () => {
    const { provider, asked } = providerSaying("Keith is asking you to sign off the training budget before Friday.");
    await expect(explainMessage(provider, message, "training budget")).resolves.toBe("Keith is asking you to sign off the training budget before Friday.");
    // The operator's question goes in, so the sentence answers it rather than
    // summarising the mail in general.
    expect(JSON.stringify(asked[0])).toContain("training budget");
  });

  it("trims a model that answered with a paragraph and a newline", async () => {
    const { provider } = providerSaying("  Keith wants a sign-off.\n\nHe is waiting.  ");
    await expect(explainMessage(provider, message, "budget")).resolves.toBe("Keith wants a sign-off. He is waiting.");
  });

  /** A model that says nothing is not an answer to show under a score. */
  it("refuses an empty answer rather than showing a blank reason", async () => {
    const { provider } = providerSaying("   ");
    await expect(explainMessage(provider, message, "budget")).rejects.toThrow(/nothing/i);
  });
});
