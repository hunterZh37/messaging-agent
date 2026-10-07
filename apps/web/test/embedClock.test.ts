import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The module keeps a `quiet` flag across ticks on purpose (so a persistent
 * failure logs once, not once a minute) — see `embedClock.ts`. That flag is
 * module state, so each test re-imports the module fresh rather than share
 * it, and the "swallows an error" case is free to call `embedBatch` more
 * than once within itself to see the flag do its job (2026-10-07).
 */
let embedBatch: typeof import("../lib/embedClock").embedBatch;
let EMBED_BATCH: number;

beforeEach(async () => {
  vi.resetModules();
  ({ embedBatch, EMBED_BATCH } = await import("../lib/embedClock"));
});

describe("embedBatch", () => {
  it("embeds a batch and says there is more to do", async () => {
    const embed = vi.fn(async () => ({ embedded: EMBED_BATCH, reembedded: 0 }));
    await expect(embedBatch({ embed, sorting: () => false })).resolves.toEqual({ embedded: EMBED_BATCH, resting: false });
  });

  it("rests once a pass embeds less than a full batch", async () => {
    const embed = vi.fn(async () => ({ embedded: 3, reembedded: 0 }));
    await expect(embedBatch({ embed, sorting: () => false })).resolves.toEqual({ embedded: 3, resting: true });
  });

  /** One local model, and a question they are waiting on beats a backfill they are not. */
  it("does nothing while the sorter has the model", async () => {
    const embed = vi.fn(async () => ({ embedded: 0, reembedded: 0 }));
    await expect(embedBatch({ embed, sorting: () => true })).resolves.toEqual({ embedded: 0, resting: false });
    expect(embed).not.toHaveBeenCalled();
  });

  /** Ollama off for a week must not be a line in the log every minute. */
  it("swallows an error, counts nothing, and says nothing the second time", async () => {
    const embed = vi.fn(async () => {
      throw new Error("no ollama");
    });
    const said: string[] = [];
    const log = (m: string) => said.push(m);
    await expect(embedBatch({ embed, sorting: () => false, log })).resolves.toEqual({ embedded: 0, resting: false });
    await embedBatch({ embed, sorting: () => false, log });
    await embedBatch({ embed, sorting: () => false, log });
    expect(said).toEqual(["embed clock: no ollama"]);
  });
});
