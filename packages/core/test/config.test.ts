import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, ensureConfigFiles, readTextFile, MODELS, MODEL_ENV_VARS, MODEL_ROLES, OUTLOOK_SCOPES, OUTLOOK_CATEGORIES, LABELS, EMBED_MODEL } from "../src/config";

describe("loadConfig", () => {
  it("defaults dataDir to ~/messaging-agent", () => {
    const cfg = loadConfig({}, "/Users/test");
    expect(cfg.dataDir).toBe("/Users/test/messaging-agent");
    expect(cfg.dbPath).toBe("/Users/test/messaging-agent/messaging-agent.sqlite");
    expect(cfg.blobsDir).toBe("/Users/test/messaging-agent/blobs");
    expect(cfg.criteriaPath).toBe("/Users/test/messaging-agent/criteria.md");
    expect(cfg.voicePath).toBe("/Users/test/messaging-agent/voice.md");
    expect(cfg.blocklistPath).toBe("/Users/test/messaging-agent/blocklist.txt");
    expect(cfg.rulesPath).toBe("/Users/test/messaging-agent/rules.md");
    expect(cfg.rulesPrevPath).toBe("/Users/test/messaging-agent/rules.prev.md");
  });

  it("honours MESSAGING_AGENT_DATA_DIR and secrets", () => {
    const cfg = loadConfig(
      { MESSAGING_AGENT_DATA_DIR: "/tmp/x", ANTHROPIC_API_KEY: "k", MICROSOFT_CLIENT_ID: "ms-id" },
      "/Users/test",
    );
    expect(cfg.dataDir).toBe("/tmp/x");
    expect(cfg.blobsDir).toBe("/tmp/x/blobs");
    expect(cfg.anthropicApiKey).toBe("k");
    expect(cfg.microsoft).toEqual({ clientId: "ms-id" });
  });

  it("leaves microsoft.clientId undefined when unset", () => {
    const cfg = loadConfig({}, "/Users/test");
    expect(cfg.microsoft).toEqual({ clientId: undefined });
  });

  it("points the embedder at local Ollama by default and honours OLLAMA_URL", () => {
    expect(loadConfig({}, "/Users/test").ollamaUrl).toBe("http://127.0.0.1:11434");
    expect(loadConfig({}, "/Users/test").embedModel).toBe(EMBED_MODEL);
    expect(loadConfig({ OLLAMA_URL: " http://ollama.local:1234 " }, "/Users/test").ollamaUrl).toBe("http://ollama.local:1234");
  });

  it("pins model ids", () => {
    expect(MODELS.sorter).toBe("claude-haiku-4-5");
    expect(MODELS.drafter).toBe("claude-sonnet-5");
    expect(EMBED_MODEL).toBe("nomic-embed-text");
  });

  it("defaults each role to its pinned Claude model", () => {
    const cfg = loadConfig({}, "/Users/test");
    expect(cfg.models.sorter).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
    expect(cfg.models.drafter).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
    expect(cfg.models.chat).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
  });

  it("leaves the backlog sorter on the trickle model until the operator names one", () => {
    expect(loadConfig({}, "/Users/test").models.sorter_backlog).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
    const local = loadConfig({ CELESTE_MODEL_SORTER: "ollama:qwen3:8b" }, "/Users/test");
    expect(local.models.sorter_backlog).toEqual({ provider: "ollama", model: "qwen3:8b" });
    const both = loadConfig({ CELESTE_MODEL_SORTER: "ollama:qwen3:8b", CELESTE_MODEL_SORTER_BACKLOG: " claude-haiku-4-5 " }, "/Users/test");
    expect(both.models.sorter).toEqual({ provider: "ollama", model: "qwen3:8b" });
    expect(both.models.sorter_backlog).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
  });

  it("names every role's environment variable", () => {
    expect(MODEL_ROLES).toEqual(["sorter", "sorter_backlog", "drafter", "chat", "stats"]);
    expect(MODEL_ENV_VARS.sorter_backlog).toBe("CELESTE_MODEL_SORTER_BACKLOG");
  });

  it("lets the environment put a local model behind any single role", () => {
    const cfg = loadConfig({ CELESTE_MODEL_SORTER: " ollama:qwen3:8b " }, "/Users/test");
    expect(cfg.models.sorter).toEqual({ provider: "ollama", model: "qwen3:8b" });
    expect(cfg.models.drafter).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });
    expect(loadConfig({ CELESTE_MODEL_CHAT: "claude-opus-5" }, "/Users/test").models.chat).toEqual({
      provider: "anthropic",
      model: "claude-opus-5",
    });
  });

  it("defines the outlook scopes and reuses the agent label names as categories", () => {
    expect(OUTLOOK_SCOPES).toEqual(["offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send"]);
    expect(OUTLOOK_CATEGORIES).toEqual(LABELS);
  });
});

describe("ensureConfigFiles", () => {
  it("creates templates once and never overwrites", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ma-"));
    const cfg = loadConfig({ MESSAGING_AGENT_DATA_DIR: dir }, "/unused");
    await ensureConfigFiles(cfg);
    const first = await readFile(cfg.criteriaPath, "utf8");
    expect(first).toContain("# Importance criteria");
    await writeFile(cfg.criteriaPath, "custom");
    await ensureConfigFiles(cfg);
    expect(await readTextFile(cfg.criteriaPath)).toBe("custom");
    expect(await readTextFile(cfg.voicePath)).toContain("# Voice");
    expect(await readTextFile(cfg.blocklistPath)).toContain("# One email");
  });
});

/**
 * Jev sorts where it can be reached (operator, 2026-09-21: "make Jev the live
 * sorter"). It settles a message in a fraction of the time the local model
 * takes, so having a key for it and not using it is a choice nobody made on
 * purpose. Naming a sorter still wins, and no key changes nothing.
 */
describe("which model sorts", () => {
  it("is Jev once there is a key for it", () => {
    const cfg = loadConfig({ TYPESAFE_API_KEY: "k" }, "/Users/test");
    expect(cfg.models.sorter).toEqual({ provider: "typesafe", model: "jev-latest" });
    expect(cfg.typesafeApiKey).toBe("k");
  });

  it("carries Jev to the backlog sorter too, which had no model of its own", () => {
    expect(loadConfig({ TYPESAFE_API_KEY: "k" }, "/Users/test").models.sorter_backlog).toEqual({ provider: "typesafe", model: "jev-latest" });
  });

  it("is whatever the environment names, key or no key", () => {
    const cfg = loadConfig({ TYPESAFE_API_KEY: "k", [MODEL_ENV_VARS.sorter]: "ollama:qwen3:8b" }, "/Users/test");
    expect(cfg.models.sorter).toEqual({ provider: "ollama", model: "qwen3:8b" });
  });

  it("is what it always was with no key", () => {
    expect(loadConfig({}, "/Users/test").models.sorter).toEqual({ provider: "anthropic", model: MODELS.sorter });
  });

  it("holds no key when the variable is blank", () => {
    expect(loadConfig({ TYPESAFE_API_KEY: "   " }, "/Users/test").typesafeApiKey).toBeUndefined();
  });
});
