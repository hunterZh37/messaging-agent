import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * `localModelBusy()` ORs three inputs together: the mail clock's own ticker
 * (never started here, so always false — that half was already correct and
 * reviewed before this fix); `syncModelBusy()` from `@/lib/syncAll`, pinned
 * by fix round 1 (a sort/draft mid-run via `processMail`, even with no fetch
 * in flight — `processMail` is fire-and-forget from the mail clock's own
 * tick); and `ollamaChatBusy()` from `@messaging-agent/core`, added in fix
 * round 2 for the manual actions (Re-sort, draft, revise) that call the
 * sorter/drafter directly and never go through `processMail` at all.
 */
const mocks = vi.hoisted(() => ({ syncModelBusy: vi.fn(() => false), ollamaChatBusy: vi.fn(() => false) }));
vi.mock("@/lib/syncAll", () => ({
  fetchMail: vi.fn(),
  processMail: vi.fn(),
  syncAllChats: vi.fn(),
  syncModelBusy: mocks.syncModelBusy,
}));
vi.mock("@messaging-agent/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@messaging-agent/core")>();
  return { ...actual, ollamaChatBusy: mocks.ollamaChatBusy };
});

import { localModelBusy } from "../lib/mailClock";

describe("localModelBusy", () => {
  beforeEach(() => {
    mocks.syncModelBusy.mockReturnValue(false);
    mocks.ollamaChatBusy.mockReturnValue(false);
  });

  it("is false when the clock is idle, nothing is mid-sort, and nothing is on the wire", () => {
    expect(localModelBusy()).toBe(false);
  });

  it("is true while a sort/draft is mid-run via processMail, even between its individual model calls", () => {
    mocks.syncModelBusy.mockReturnValue(true);
    expect(localModelBusy()).toBe(true);
  });

  it("is true while a chat call is literally in flight, the signal that covers manual actions processMail never sees", () => {
    mocks.ollamaChatBusy.mockReturnValue(true);
    expect(localModelBusy()).toBe(true);
  });
});
