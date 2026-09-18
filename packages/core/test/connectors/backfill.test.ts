import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { accountRow, testDb } from "../helpers/db";
import { accounts } from "../../src/db/schema";
import { needsBackfill, noteBackfilledSince } from "../../src/connectors/backfill";

const NOW = 1_757_000_000_000;
const DAY = 86_400_000;

function account(backfilledSince: number | null) {
  return accountRow({ id: "a1", provider: "imap", email: "me@example.com", backfilledSince });
}

describe("needsBackfill", () => {
  it("is false for a window already covered", () => {
    expect(needsBackfill(account(NOW - 30 * DAY), NOW - 7 * DAY, NOW)).toBe(false);
    expect(needsBackfill(account(NOW - 7 * DAY), NOW - 7 * DAY, NOW)).toBe(false);
  });

  it("is true for a window older than the synced depth", () => {
    expect(needsBackfill(account(NOW - 7 * DAY), NOW - 30 * DAY, NOW)).toBe(true);
  });

  it("assumes the initial 7-day window when the account has never recorded a depth", () => {
    expect(needsBackfill(account(null), NOW - 7 * DAY, NOW)).toBe(false);
    expect(needsBackfill(account(null), NOW - 30 * DAY, NOW)).toBe(true);
  });

  it("treats the All window as satisfied only by a whole-mailbox backfill", () => {
    expect(needsBackfill(account(0), null, NOW)).toBe(false);
    expect(needsBackfill(account(null), null, NOW)).toBe(true);
    expect(needsBackfill(account(NOW - 365 * DAY), null, NOW)).toBe(true);
  });

  it("is false for any window once the whole mailbox is synced", () => {
    expect(needsBackfill(account(0), NOW - 365 * DAY, NOW)).toBe(false);
  });
});

describe("noteBackfilledSince", () => {
  it("records a depth on an account that had none", () => {
    const db = testDb();
    const a = account(null);
    db.insert(accounts).values(a).run();

    noteBackfilledSince(db, a, NOW - 30 * DAY);

    expect(db.select().from(accounts).where(eq(accounts.id, "a1")).get()?.backfilledSince).toBe(NOW - 30 * DAY);
  });

  it("stores 0 for a whole-mailbox backfill", () => {
    const db = testDb();
    const a = account(NOW - 30 * DAY);
    db.insert(accounts).values(a).run();

    noteBackfilledSince(db, a, null);

    expect(db.select().from(accounts).where(eq(accounts.id, "a1")).get()?.backfilledSince).toBe(0);
  });

  it("only ever moves the depth earlier", () => {
    const db = testDb();
    const a = account(NOW - 30 * DAY);
    db.insert(accounts).values(a).run();

    noteBackfilledSince(db, a, NOW - 7 * DAY);
    expect(db.select().from(accounts).where(eq(accounts.id, "a1")).get()?.backfilledSince).toBe(NOW - 30 * DAY);

    noteBackfilledSince(db, a, null);
    expect(db.select().from(accounts).where(eq(accounts.id, "a1")).get()?.backfilledSince).toBe(0);
  });
});

describe("needsBackfill against the window it was measured with", () => {
  it("does not ask for a backfill of the very window an unrecorded account is assumed to hold", () => {
    // The page computes the window start and the check from one clock, so an
    // account with no recorded depth reads as already holding 7 days.
    expect(needsBackfill(account(null), NOW - 7 * DAY, NOW)).toBe(false);
  });
});
