import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FetchedAccount, PipelineResult } from "@messaging-agent/core";

/**
 * `processMail` is the real production path (not a stand-in): only the
 * pieces that would otherwise reach a real database or Ollama are replaced,
 * so what's being pinned is the actual `modelBusy` bookkeeping around the
 * actual `processPending` call (2026-10-07, fix round 1) — not a second copy
 * of the logic that could drift from it. `processPending` itself is a
 * controllable promise per test, so the assertions can see `syncModelBusy()`
 * mid-flight rather than only before and after.
 */
vi.mock("@/lib/core", () => ({ core: () => ({ cfg: {}, db: {} }) }));
vi.mock("@messaging-agent/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@messaging-agent/core")>();
  return {
    ...actual,
    loadPipelineInputs: vi.fn(async () => ({ criteria: "", voice: "", blocklist: [] })),
    createSorter: vi.fn(() => ({})),
    createDrafter: vi.fn(() => null),
    connectorForAccount: vi.fn(),
    processPending: vi.fn(),
  };
});

import { processPending } from "@messaging-agent/core";
import { processMail, syncModelBusy } from "../lib/syncAll";

const result: PipelineResult = { accounts: [], sorted: 0, sortFailed: 0, drafted: 0, draftFailed: 0, pending: 0 };
const fetched: FetchedAccount[] = [];

describe("syncModelBusy", () => {
  beforeEach(() => {
    vi.mocked(processPending).mockReset();
  });

  it("is busy for as long as processMail is in flight — set before processPending is even reached", async () => {
    let resolve!: (r: PipelineResult) => void;
    vi.mocked(processPending).mockImplementation(() => new Promise((r) => (resolve = r)));

    expect(syncModelBusy()).toBe(false);
    const p = processMail(fetched);
    expect(syncModelBusy()).toBe(true); // set synchronously, before processPending is even called
    // `processMail` awaits `loadPipelineInputs` before calling `processPending`;
    // give that microtask room to land before resolving it.
    await vi.waitFor(() => expect(vi.mocked(processPending)).toHaveBeenCalled());
    resolve(result);
    await p;
    expect(syncModelBusy()).toBe(false);
  });

  it("clears even when processPending throws, so a dead model can't wedge the flag on forever", async () => {
    vi.mocked(processPending).mockRejectedValue(new Error("model unavailable"));

    const p = processMail(fetched);
    expect(syncModelBusy()).toBe(true);
    await expect(p).rejects.toThrow("model unavailable");
    expect(syncModelBusy()).toBe(false);
  });

  it("stays busy across a queued redo, and only clears once that redo finishes too", async () => {
    let resolveFirst!: (r: PipelineResult) => void;
    vi.mocked(processPending).mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)));
    let resolveSecond!: (r: PipelineResult) => void;
    vi.mocked(processPending).mockImplementationOnce(() => new Promise((r) => (resolveSecond = r)));

    const first = processMail(fetched);
    // Mail that arrives while the first round is running is folded into a
    // second round rather than starting a third concurrent one (the
    // `processing`/`waiting` queue above, unchanged by this fix). The public
    // API hands back only the first round's promise even for the joined
    // call, so the redo below is watched through `syncModelBusy()` rather
    // than by awaiting a promise nothing exposes.
    const second = processMail(fetched);
    expect(first).toBe(second);

    await vi.waitFor(() => expect(vi.mocked(processPending)).toHaveBeenCalledTimes(1));
    resolveFirst(result);
    await first;
    // The redo's own `processPending` call is queued by the first round's
    // `.finally()`; `modelBusy` must not have flickered false in between.
    await vi.waitFor(() => expect(vi.mocked(processPending)).toHaveBeenCalledTimes(2));
    expect(syncModelBusy()).toBe(true);

    resolveSecond(result);
    await vi.waitFor(() => expect(syncModelBusy()).toBe(false));
  });
});
