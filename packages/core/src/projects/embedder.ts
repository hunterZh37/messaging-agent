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
 */
export function createOllamaEmbedder(url: string, model: string, ledger?: EmbedderLedger): Embedder {
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
      });
    } catch {
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
