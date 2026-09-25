import { describe, it, expect } from "vitest";
import { fixGrammar, kept, KEEP_AT_LEAST } from "../../src/draft/grammar";
import type { ModelProvider, TextRequest } from "../../src/models/types";

/**
 * "Fix Grammar ... it doesn't change anything else, just fixes grammatical
 * errors" (operator, 2026-09-25). The whole body comes back corrected, which
 * is what they asked for, so the promise is kept by measuring the answer
 * against what went in rather than by trusting it.
 */

function provider(reply: string, seen: TextRequest[] = []): ModelProvider {
  return {
    ref: { provider: "ollama", model: "qwen3:8b" },
    async text(req: TextRequest) {
      seen.push(req);
      return { text: reply, usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1 };
    },
    async structured() {
      throw new Error("not used");
    },
    chat() {
      throw new Error("not used");
    },
  } as unknown as ModelProvider;
}

const DRAFT = `Hi Keith,

This won't take long at all. The 15 hours I was granted should well cover this part! I will work on it now and if I need any assist from your side (e.g. credit card info), I will create a google doc and present step cleanly for you to follow.

Thank you
Hunter`;

const FIXED = `Hi Keith,

This won't take long at all. The 15 hours I was granted should cover this part well! I will work on it now, and if I need any assistance from your side (e.g. credit card info), I will create a Google Doc and present the steps cleanly for you to follow.

Thank you
Hunter`;

describe("fixGrammar", () => {
  it("gives back the corrected body, and says it changed", async () => {
    const result = await fixGrammar(provider(FIXED), DRAFT);
    expect(result.text).toBe(FIXED);
    expect(result.changed).toBe(true);
    expect(result.refused).toBeUndefined();
  });

  it("says plainly when there was nothing to fix", async () => {
    const result = await fixGrammar(provider(DRAFT), DRAFT);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(DRAFT);
  });

  it("sends the draft as it stands, with the proofreading rule above it", async () => {
    const seen: TextRequest[] = [];
    await fixGrammar(provider(FIXED, seen), DRAFT);
    expect(seen[0]?.messages[0]?.content).toBe(DRAFT);
    const rules = seen[0]?.system.map((b) => b.text).join("\n") ?? "";
    expect(rules).toContain("change nothing else");
    expect(rules).toContain("Keep every line break");
  });

  /** The risk the operator's own wording runs: a model that rewrites. */
  it("refuses a body that came back rewritten, and keeps theirs", async () => {
    const rewritten = `Dear Keith,

I hope this email finds you well. I wanted to reach out regarding the project timeline. I am confident that the allocated time will be more than sufficient for the deliverables in question, and I shall commence work immediately.

Warm regards,
Hunter`;
    const result = await fixGrammar(provider(rewritten), DRAFT);
    expect(result.text).toBe(DRAFT);
    expect(result.changed).toBe(false);
    expect(result.refused).toMatch(/rewritten/);
  });

  it("refuses a body that lost or gained paragraphs", async () => {
    const squashed = DRAFT.split("\n\n").slice(0, 2).join("\n\n");
    const result = await fixGrammar(provider(squashed), DRAFT);
    expect(result.text).toBe(DRAFT);
    expect(result.refused).toMatch(/laid out differently/);
  });

  it("takes the body out of a fence a local model wrapped it in", async () => {
    const result = await fixGrammar(provider("```\n" + FIXED + "\n```"), DRAFT);
    expect(result.text).toBe(FIXED);
  });

  it("refuses an empty answer rather than emptying the draft", async () => {
    const result = await fixGrammar(provider("   "), DRAFT);
    expect(result.text).toBe(DRAFT);
    expect(result.refused).toMatch(/nothing/);
  });

  it("asks nothing of the model for an empty draft", async () => {
    const seen: TextRequest[] = [];
    const result = await fixGrammar(provider(FIXED, seen), "   ");
    expect(result.changed).toBe(false);
    expect(seen).toHaveLength(0);
  });
});

describe("kept", () => {
  it("is all of it when nothing moved, and near all for a word or two fixed", () => {
    expect(kept(DRAFT, DRAFT)).toBe(1);
    expect(kept(DRAFT, FIXED)).toBeGreaterThan(KEEP_AT_LEAST);
  });

  it("falls below the line when the mail is written again", () => {
    expect(kept(DRAFT, "Dear Keith, I hope this finds you well. Kind regards, Hunter")).toBeLessThan(KEEP_AT_LEAST);
  });

  it("counts cutting half the mail as losing half of it", () => {
    const half = DRAFT.slice(0, Math.floor(DRAFT.length / 2));
    expect(kept(DRAFT, half)).toBeLessThan(KEEP_AT_LEAST);
  });
});
