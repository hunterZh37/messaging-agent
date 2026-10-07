import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * `localModelBusy()` is two inputs ORed together: the mail clock's own
 * ticker (never started here, so always false — that half was already
 * correct and reviewed before this fix) and `syncModelBusy()` from
 * `@/lib/syncAll`, which is the part this test pins (2026-10-07, fix round
 * 1): a sort/draft mid-run via `processMail` must read as busy even with no
 * fetch in flight, which is exactly the bug — `processMail` is
 * fire-and-forget from the mail clock's own tick, so the ticker alone was
 * done well before the sort was.
 */
const mocks = vi.hoisted(() => ({ syncModelBusy: vi.fn(() => false) }));
vi.mock("@/lib/syncAll", () => ({
  fetchMail: vi.fn(),
  processMail: vi.fn(),
  syncAllChats: vi.fn(),
  syncModelBusy: mocks.syncModelBusy,
}));

import { localModelBusy } from "../lib/mailClock";

describe("localModelBusy", () => {
  beforeEach(() => {
    mocks.syncModelBusy.mockReturnValue(false);
  });

  it("is false when the clock is idle and nothing is mid-sort", () => {
    expect(localModelBusy()).toBe(false);
  });

  it("is true while a sort/draft is mid-run, even with no fetch in flight", () => {
    mocks.syncModelBusy.mockReturnValue(true);
    expect(localModelBusy()).toBe(true);
  });
});
