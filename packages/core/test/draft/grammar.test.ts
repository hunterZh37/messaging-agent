import { describe, it, expect } from "vitest";
import { facts, fixGrammar, kept, KEEP_AT_LEAST, tokens } from "../../src/draft/grammar";
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

/**
 * Everything a correction must not do, proved rather than asked for. Each of
 * these came back from a review on 2026-09-25, two of them reproduced against
 * the real local model.
 */
describe("what a correction may not touch", () => {
  it("keeps the blank line the draft ended with, and calls an identical answer unchanged", async () => {
    const withTail = `${DRAFT}\n\n`;
    const result = await fixGrammar(provider(DRAFT), withTail);
    expect(result.text).toBe(withTail);
    expect(result.changed).toBe(false);
  });

  it("does not refuse an honest fix because the draft ended in blank lines", async () => {
    const withTail = `${DRAFT}\n\n\n\n`;
    const result = await fixGrammar(provider(FIXED), withTail);
    expect(result.refused).toBeUndefined();
    expect(result.text).toBe(`${FIXED}\n\n\n\n`);
  });

  it("takes off the trailing spaces a local model likes to add", async () => {
    const draft = "Hi Sam,\n\nThank you for the update.\n\nBest,\nHunter";
    const spaced = draft.replace("Best,", "Best,  ");
    const result = await fixGrammar(provider(spaced), draft);
    expect(result.text).toBe(draft);
    expect(result.changed).toBe(false);
  });

  it("leaves trailing spaces the operator put there", async () => {
    const draft = "Hi Sam,  \n\nThank you for the update.\n\nBest,\nHunter";
    const result = await fixGrammar(provider(draft), draft);
    expect(result.text).toBe(draft);
  });

  it("refuses a number, a sum or a date that moved", async () => {
    const moved = FIXED.replace("15 hours", "50 hours");
    const result = await fixGrammar(provider(moved), DRAFT);
    expect(result.text).toBe(DRAFT);
    expect(result.refused).toMatch(/15/);
  });

  it("refuses a link that moved", async () => {
    const draft = "Hi Ana,\n\nThe folder is at https://example.com/a/b and i will add the rest tomorrow.\n\nHunter";
    const moved = draft.replace("https://example.com/a/b", "https://example.com/x/y").replace(" i ", " I ");
    const result = await fixGrammar(provider(moved), draft);
    expect(result.text).toBe(draft);
    expect(result.refused).toMatch(/example\.com/);
  });

  it("refuses an answer that dropped the operator's emphasis", async () => {
    const draft = "Hi Ana,\n\nthis is **important** and i will send it today.\n\nHunter";
    const flattened = draft.replace("**important**", "important").replace(" i ", " I ");
    const result = await fixGrammar(provider(flattened), draft);
    expect(result.text).toBe(draft);
    expect(result.refused).toMatch(/bold or underline/);
  });

  it("refuses a mail whose paragraphs came back shuffled", async () => {
    const shuffled = DRAFT.split("\n\n").reverse().join("\n\n");
    const result = await fixGrammar(provider(shuffled), DRAFT);
    expect(result.text).toBe(DRAFT);
    expect(result.refused).toMatch(/greeting or sign-off/);
  });

  /**
   * A reviewer put this through the real local model on 2026-09-25: it fixed
   * the 在/再 homophone correctly and the guard threw the fix away, because a
   * whole clause counted as one word in a script that has no spaces.
   */
  it("accepts a one-character fix in a language written without spaces", async () => {
    const draft = "我们明天再公司开会，好吗？";
    const fixed = "我们明天在公司开会，好吗？";
    const result = await fixGrammar(provider(fixed), draft);
    expect(result.refused).toBeUndefined();
    expect(result.text).toBe(fixed);
  });
});

describe("tokens", () => {
  it("counts a Chinese character as a piece of its own, and a Latin word as one", () => {
    expect(tokens("我们明天")).toEqual(["我", "们", "明", "天"]);
    expect(tokens("Hello there")).toEqual(["hello", "there"]);
  });
});

describe("facts", () => {
  it("picks out the numbers, links and addresses a correction must keep", () => {
    const found = facts("Send 15 copies to ana@example.com via https://example.com/x by 2026-09-30.");
    expect(found).toContain("15");
    expect(found).toContain("ana@example.com");
    expect(found).toContain("https://example.com/x");
    expect(found).toContain("2026-09-30");
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

  it("sees words moved out of their order, not only words gone", () => {
    // The same words, read backwards: a bag of words calls this untouched.
    const backwards = tokens(DRAFT).reverse().join(" ");
    expect(kept(DRAFT, backwards)).toBeLessThan(KEEP_AT_LEAST);
  });

  it("counts cutting half the mail as losing half of it", () => {
    const half = DRAFT.slice(0, Math.floor(DRAFT.length / 2));
    expect(kept(DRAFT, half)).toBeLessThan(KEEP_AT_LEAST);
  });
});
