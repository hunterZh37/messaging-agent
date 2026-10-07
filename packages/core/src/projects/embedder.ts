import { EMBEDDING_DIMENSIONS, type Db } from "../db/client";
import { recordModelCall } from "../models/ledger";

/**
 * Thrown whenever project filing cannot run: no Ollama, no model, no
 * sqlite-vec. Always carries a message the UI can show as-is, naming the
 * fix rather than the failure.
 */
export class EmbeddingsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingsUnavailableError";
  }
}

/** One vector per input text, in order. */
export interface Embedder {
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** Ollama holds the whole batch in memory at once, so the batch stays small. */
const BATCH = 16;

/**
 * How long the embedder on `askCeleste`'s path waits before giving up on
 * Ollama and letting the keyword half answer alone. The operator is
 * waiting on this one, unlike the background backfill, so it is seconds
 * rather than the minutes a cold model load can legitimately take
 * (2026-10-07).
 */
export const QUERY_EMBED_TIMEOUT_MS = 2_500;

/**
 * Where an embedding batch is written down (spec 13). Ollama's embed
 * endpoint reports no token counts at all, so a row carries the time it took
 * and nothing else: one row per batch, and the cost is zero because the
 * model runs on the operator's own Mac.
 */
export interface EmbedderLedger {
  db: Db;
  accountId?: string;
}

/**
 * The local embedder (spec 11a). Nothing here leaves the Mac: it talks to
 * Ollama on the loopback address and no further.
 *
 * `timeoutMs`, when given, bounds every call to Ollama and turns a hang into
 * the same `EmbeddingsUnavailableError` a connection refusal already is, so
 * a caller that falls back to the keyword half on that error does so on a
 * wedged Ollama too. Left unset it waits as long as Ollama takes, which is
 * the background backfill's whole job: one `createOllamaEmbedder` serves
 * both, so the ceiling is this parameter, not a constant in here, and the
 * query path below is the one that asks for a short one (2026-10-07 — before
 * this, a stuck or cold-loading Ollama blocked `askCeleste` with no ceiling
 * at all, which the design spec's "half an answer beats an error" rules
 * out).
 */
export function createOllamaEmbedder(url: string, model: string, ledger?: EmbedderLedger, timeoutMs?: number): Embedder {
  const endpoint = `${url.replace(/\/+$/, "")}/api/embed`;

  const record = (startedAt: number, error?: string): void => {
    if (!ledger) return;
    recordModelCall(ledger.db, {
      role: "embed",
      ...(ledger.accountId ? { accountId: ledger.accountId } : {}),
      modelRef: { provider: "ollama", model },
      kind: "embed",
      usage: { inputTokens: 0, outputTokens: 0 },
      latencyMs: Date.now() - startedAt,
      ...(error ? { error } : {}),
    });
  };

  /** One batch through Ollama. Every failure here is a setup step, named as one. */
  async function embedBatch(batch: string[]): Promise<Float32Array[]> {
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: batch }),
        ...(timeoutMs !== undefined ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      });
    } catch (err) {
      // A hung or still-loading Ollama is "running" by every other measure
      // in this file, so it earns its own message rather than borrowing
      // "not running"'s and sending someone to restart the wrong thing.
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new EmbeddingsUnavailableError(`Ollama did not answer within ${timeoutMs}ms at ${url}`);
      }
      // Connection refused is the everyday case: Ollama is not installed
      // or not running, which is a setup step, not an error to report.
      throw new EmbeddingsUnavailableError(`Ollama is not running at ${url}`);
    }
    if (res.status === 404) throw new EmbeddingsUnavailableError(`Model ${model} is not pulled`);
    if (!res.ok) throw new EmbeddingsUnavailableError(`Ollama answered ${res.status} at ${url}`);

    const body = (await res.json()) as { embeddings?: number[][] };
    const embeddings = body.embeddings;
    if (!Array.isArray(embeddings) || embeddings.length !== batch.length) {
      throw new EmbeddingsUnavailableError(`Ollama returned ${embeddings?.length ?? 0} embeddings for ${batch.length} texts`);
    }
    const vectors: Float32Array[] = [];
    for (const vector of embeddings) {
      if (vector.length !== EMBEDDING_DIMENSIONS) {
        throw new EmbeddingsUnavailableError(`Model ${model} returned ${vector.length} dimensions, expected ${EMBEDDING_DIMENSIONS}`);
      }
      vectors.push(Float32Array.from(vector));
    }
    return vectors;
  }

  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const startedAt = Date.now();
        try {
          out.push(...(await embedBatch(texts.slice(i, i + BATCH))));
          record(startedAt);
        } catch (err) {
          record(startedAt, (err as Error).message);
          throw err;
        }
      }
      return out;
    },
  };
}
