import { describe, it, expect } from "vitest";
import { formatModelRef, parseModelRef } from "../../src/models/types";

describe("parseModelRef", () => {
  it("splits on the first colon, so an Ollama tag keeps its own", () => {
    expect(parseModelRef("ollama:qwen3:8b")).toEqual({ provider: "ollama", model: "qwen3:8b" });
  });

  it("reads an explicit anthropic prefix", () => {
    expect(parseModelRef("anthropic:claude-haiku-4-5")).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
  });

  it("treats a bare name as Anthropic", () => {
    expect(parseModelRef("claude-sonnet-5")).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
  });

  it("keeps an unknown prefix as part of an Anthropic model name", () => {
    expect(parseModelRef("qwen3:8b")).toEqual({ provider: "anthropic", model: "qwen3:8b" });
  });

  it("trims surrounding space", () => {
    expect(parseModelRef("  ollama:qwen3:8b  ")).toEqual({ provider: "ollama", model: "qwen3:8b" });
  });

  it("rejects an empty ref and a provider with no model", () => {
    expect(() => parseModelRef("   ")).toThrow(/empty/i);
    expect(() => parseModelRef("ollama:")).toThrow(/model/i);
  });
});

describe("formatModelRef", () => {
  it("round-trips", () => {
    expect(formatModelRef({ provider: "ollama", model: "qwen3:8b" })).toBe("ollama:qwen3:8b");
    expect(formatModelRef({ provider: "anthropic", model: "claude-haiku-4-5" })).toBe("anthropic:claude-haiku-4-5");
    expect(parseModelRef(formatModelRef({ provider: "anthropic", model: "claude-haiku-4-5" }))).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
  });
});
