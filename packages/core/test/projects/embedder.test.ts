import { describe, it, expect, afterEach, vi } from "vitest";
import { EMBEDDING_DIMENSIONS } from "../../src/db/client";
import { modelCalls } from "../../src/db/schema";
import { createOllamaEmbedder, EmbeddingsUnavailableError } from "../../src/projects/embedder";
import { testDb } from "../helpers/db";

const URL = "http://127.0.0.1:11434";
const MODEL = "nomic-embed-text";

function vector(fill: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, () => fill);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createOllamaEmbedder", () => {
  it("posts to /api/embed and returns one Float32Array per text", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { input: string[] };
      calls.push({ url, body });
      return jsonResponse({ embeddings: body.input.map((_, i) => vector(i + 1)) });
    });

    const vectors = await createOllamaEmbedder(URL, MODEL).embed(["one", "two"]);

    expect(calls[0]?.url).toBe(`${URL}/api/embed`);
    expect(calls[0]?.body).toEqual({ model: MODEL, input: ["one", "two"] });
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toBeInstanceOf(Float32Array);
    expect(vectors[0]!.length).toBe(EMBEDDING_DIMENSIONS);
    expect(vectors[1]![0]).toBe(2);
  });

  it("sends batches of 16, in order", async () => {
    const batches: number[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { input: string[] };
      batches.push(body.input.length);
      return jsonResponse({ embeddings: body.input.map(() => vector(1)) });
    });

    const texts = Array.from({ length: 35 }, (_, i) => `text ${i}`);
    const vectors = await createOllamaEmbedder(URL, MODEL).embed(texts);

    expect(batches).toEqual([16, 16, 3]);
    expect(vectors).toHaveLength(35);
  });

  it("names the fix when Ollama is not running", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await expect(createOllamaEmbedder(URL, MODEL).embed(["one"])).rejects.toThrow(
      new EmbeddingsUnavailableError(`Ollama is not running at ${URL}`),
    );
  });

  it("names the fix when the model is not pulled", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({ error: "model not found" }, 404));
    const error = await createOllamaEmbedder(URL, MODEL)
      .embed(["one"])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbeddingsUnavailableError);
    expect((error as Error).message).toBe(`Model ${MODEL} is not pulled`);
  });

  it("refuses a reply with the wrong shape rather than filing on nonsense", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({ embeddings: [vector(1)] }));
    await expect(createOllamaEmbedder(URL, MODEL).embed(["one", "two"])).rejects.toThrow(EmbeddingsUnavailableError);

    vi.stubGlobal("fetch", async () => jsonResponse({ embeddings: [[1, 2, 3]] }));
    await expect(createOllamaEmbedder(URL, MODEL).embed(["one"])).rejects.toThrow("3 dimensions");
  });

  it("takes a url with a trailing slash", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return jsonResponse({ embeddings: [vector(1)] });
    });
    await createOllamaEmbedder(`${URL}/`, MODEL).embed(["one"]);
    expect(urls[0]).toBe(`${URL}/api/embed`);
  });
});

describe("the embedder's ledger rows", () => {
  it("writes one free row per batch, with no tokens Ollama never reported", async () => {
    const db = testDb();
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { input: string[] };
      return jsonResponse({ embeddings: body.input.map(() => vector(1)) });
    });

    // Two batches: seventeen texts go through Ollama sixteen at a time.
    await createOllamaEmbedder(URL, MODEL, { db, accountId: "acc-1" }).embed(Array.from({ length: 17 }, (_, i) => `text ${i}`));

    const rows = db.select().from(modelCalls).all();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      role: "embed",
      kind: "embed",
      provider: "ollama",
      model: MODEL,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      accountId: "acc-1",
      error: null,
    });
  });

  it("writes the row that failed, and keeps throwing", async () => {
    const db = testDb();
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });

    await expect(createOllamaEmbedder(URL, MODEL, { db }).embed(["one"])).rejects.toThrow(EmbeddingsUnavailableError);

    expect(db.select().from(modelCalls).all()[0]).toMatchObject({ role: "embed", error: `Ollama is not running at ${URL}` });
  });

  it("writes nothing at all when no ledger was given", async () => {
    const db = testDb();
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { input: string[] };
      return jsonResponse({ embeddings: body.input.map(() => vector(1)) });
    });

    await createOllamaEmbedder(URL, MODEL).embed(["one"]);

    expect(db.select().from(modelCalls).all()).toHaveLength(0);
  });
});
