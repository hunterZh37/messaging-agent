import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The module keeps a `quiet` flag across ticks on purpose (so a persistent
 * failure logs once, not once a minute) — see `embedClock.ts`. That flag is
 * module state, so each test re-imports the module fresh rather than share
 * it, and the "swallows an error" case is free to call `embedBatch` more
 * than once within itself to see the flag do its job (2026-10-07).
 */
let embedBatch: typeof import("../lib/embedClock").embedBatch;

beforeEach(async () => {
  vi.resetModules();
  ({ embedBatch } = await import("../lib/embedClock"));
});

describe("embedBatch", () => {
  /**
   * The recheck slice `embedPending` reserves out of every batch means a
   * backlog-draining pass can never actually report `EMBED_BATCH` — 190 of
   * 200 at the clock's real settings — so a test asserting that value was
   * asserting something production cannot produce (2026-10-07, the whole-
   * branch review that caught the 190 < 200 bug this guards against).
   */
  it("keeps working while embedPending says there is more backlog, even on a short pass", async () => {
    const embed = vi.fn(async () => ({ embedded: 190, reembedded: 10, more: true }));
    await expect(embedBatch({ embed, sorting: () => false })).resolves.toEqual({ embedded: 190, resting: false });
  });

  it("rests once embedPending says the backlog is drained, even on a full-looking pass", async () => {
    const embed = vi.fn(async () => ({ embedded: 190, reembedded: 10, more: false }));
    await expect(embedBatch({ embed, sorting: () => false })).resolves.toEqual({ embedded: 190, resting: true });
  });

  it("rests once a pass finds nothing left to embed", async () => {
    const embed = vi.fn(async () => ({ embedded: 0, reembedded: 0, more: false }));
    await expect(embedBatch({ embed, sorting: () => false })).resolves.toEqual({ embedded: 0, resting: true });
  });

  /** One local model, and a question they are waiting on beats a backfill they are not. */
  it("does nothing while the sorter has the model", async () => {
    const embed = vi.fn(async () => ({ embedded: 0, reembedded: 0 }));
    await expect(embedBatch({ embed, sorting: () => true })).resolves.toEqual({ embedded: 0, resting: false });
    expect(embed).not.toHaveBeenCalled();
  });

  /**
   * Ollama off for a week must not be a line in the log every minute — and
   * must not be a full `embedPending` scan every minute either: the search
   * scope's `ORDER BY` costs 0.42s on the operator's real mailbox even to
   * find nothing, for no reason once Ollama is down (2026-10-07, the
   * review's back-off addendum). A failed pass rests the same as a drained
   * backlog, so the next tick waits `EMBED_RESTING_MS`, not `EMBED_EVERY_MS`.
   */
  it("swallows an error, counts nothing, says nothing the second time, and rests so the next tick is cheap", async () => {
    const embed = vi.fn(async () => {
      throw new Error("no ollama");
    });
    const said: string[] = [];
    const log = (m: string) => said.push(m);
    await expect(embedBatch({ embed, sorting: () => false, log })).resolves.toEqual({ embedded: 0, resting: true });
    await embedBatch({ embed, sorting: () => false, log });
    await embedBatch({ embed, sorting: () => false, log });
    expect(said).toEqual(["embed clock: no ollama"]);
  });
});
