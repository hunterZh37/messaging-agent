import { EMBEDDING_DIMENSIONS } from "../../src/db/client";
import type { Embedder } from "../../src/projects/embedder";

/** FNV-1a, so a word lands in the same slot on every run and every machine. */
function hashWord(word: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * A bag of words in 768 dimensions, unit length. Texts sharing words score
 * high, texts sharing none score zero — enough to test thresholds and
 * exemplars without Ollama anywhere near the suite.
 */
export function fakeVector(text: string): Float32Array {
  const v = new Float32Array(EMBEDDING_DIMENSIONS);
  // nomic's task prefixes tell the model what kind of text this is; they are
  // not content, and a real model does not score two documents as alike for
  // sharing one. Dropping them here keeps this double honest about that.
  const body = text.replace(/^search_(document|query):\s*/, "");
  for (const word of body.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    v[hashWord(word) % EMBEDDING_DIMENSIONS]! += 1;
  }
  let sum = 0;
  for (const x of v) sum += x * x;
  // An empty text still needs a vector cosine can divide by.
  if (sum === 0) {
    v[0] = 1;
    return v;
  }
  const norm = Math.sqrt(sum);
  for (let i = 0; i < v.length; i++) v[i]! /= norm;
  return v;
}

export class FakeEmbedder implements Embedder {
  /** Every batch handed to `embed`, in order, for tests that count calls. */
  readonly calls: string[][] = [];

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.calls.push(texts);
    return texts.map(fakeVector);
  }
}
