import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config";
import { testDb } from "../helpers/db";
import { createChatClient, createDrafter, createSorter, providerFor } from "../../src/models/factory";

/** A key that is never used: nothing in this file makes a request. */
const KEY = { ANTHROPIC_API_KEY: "test-key" };

describe("providerFor", () => {
  it("sends an ollama ref to local Ollama and an anthropic ref to the SDK", () => {
    const cfg = loadConfig({ ...KEY, OLLAMA_URL: "http://127.0.0.1:11434" }, "/Users/test");
    expect(providerFor({ provider: "ollama", model: "qwen3:8b" }, cfg).ref).toEqual({ provider: "ollama", model: "qwen3:8b" });
    expect(providerFor({ provider: "anthropic", model: "claude-haiku-4-5" }, cfg).ref).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
  });
});

describe("role factories", () => {
  it("build each role on the model its config names", () => {
    const cfg = loadConfig({ ...KEY }, "/Users/test");
    expect(createSorter(cfg, testDb()).model).toBe("anthropic:claude-haiku-4-5");
    expect(createDrafter(cfg).model).toBe("anthropic:claude-sonnet-5");
    expect(createChatClient(cfg).model).toBe("anthropic:claude-sonnet-5");
  });

  it("moves one role to a local model without touching the others", () => {
    const cfg = loadConfig({ ...KEY, CELESTE_MODEL_SORTER: "ollama:qwen3:8b" }, "/Users/test");
    expect(createSorter(cfg, testDb()).model).toBe("ollama:qwen3:8b");
    expect(createDrafter(cfg).model).toBe("anthropic:claude-sonnet-5");
  });

  it("sends bulk jobs to the backlog model and the trickle to the local one", () => {
    const cfg = loadConfig({ ...KEY, CELESTE_MODEL_SORTER: "ollama:qwen3:8b", CELESTE_MODEL_SORTER_BACKLOG: "claude-haiku-4-5" }, "/Users/test");
    expect(createSorter(cfg, testDb(), "trickle").model).toBe("ollama:qwen3:8b");
    expect(createSorter(cfg, testDb(), "backlog").model).toBe("anthropic:claude-haiku-4-5");
  });

  it("puts the backlog job on the trickle model when the operator named none", () => {
    const cfg = loadConfig({ ...KEY, CELESTE_MODEL_SORTER: "ollama:qwen3:8b" }, "/Users/test");
    expect(createSorter(cfg, testDb(), "backlog").model).toBe("ollama:qwen3:8b");
  });
});

/**
 * Jev is built straight into a sorter (operator, 2026-09-21). It is not a
 * prompt model, so there is no provider to wrap and nothing to hand it
 * examples or rules.
 */
describe("the sorter when the role names Jev", () => {
  const cfg = (env: NodeJS.ProcessEnv) => loadConfig(env, "/Users/test");

  it("is Jev, and says so", () => {
    expect(createSorter(cfg({ TYPESAFE_API_KEY: "k" }), testDb()).model).toBe("typesafe:jev-latest");
  });

  it("is Jev for the backlog too", () => {
    expect(createSorter(cfg({ TYPESAFE_API_KEY: "k" }), testDb(), "backlog").model).toBe("typesafe:jev-latest");
  });

  it("says plainly when the model is named and the key is not there", () => {
    expect(() => createSorter(cfg({ CELESTE_MODEL_SORTER: "typesafe:jev-latest" }), testDb())).toThrow(/TYPESAFE_API_KEY/);
  });

  /** Asked for as another role's prompt model, it says what it actually is. */
  it("refuses to stand in as a prompt model", () => {
    expect(() => providerFor({ provider: "typesafe", model: "jev-latest" }, cfg({}))).toThrow(/sorter, not a prompt model/);
  });
});
