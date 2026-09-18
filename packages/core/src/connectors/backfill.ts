import { eq } from "drizzle-orm";
import { now, type Db } from "../db/client";
import { accounts, type AccountRow } from "../db/schema";

/** The window the first sync of an account covers (spec 5, "Backfill and retention"). */
export const INITIAL_BACKFILL_DAYS = 7;

/**
 * Does this account still have to reach back further before the operator's
 * chosen window is honest? `windowStart` is the epoch ms the window starts
 * at, or null for "All" (the whole mailbox). An account that has never
 * recorded a depth is assumed to hold the initial 7-day window, so pass the
 * same `at` the window start was computed from: a few milliseconds of drift
 * would otherwise read as a 7-day window the account has not reached.
 */
export function needsBackfill(account: AccountRow, windowStart: number | null, at: number = now()): boolean {
  if (windowStart === null) return account.backfilledSince !== 0;
  if (account.backfilledSince === 0) return false;
  const depth = account.backfilledSince ?? at - INITIAL_BACKFILL_DAYS * 86_400_000;
  return depth > windowStart;
}

/**
 * Remembers how far back an account has been synced. `since` is null for a
 * whole-mailbox backfill, stored as 0. The depth only ever moves earlier, so
 * a later shallow sync never forgets a deep backfill.
 */
export function noteBackfilledSince(db: Db, account: AccountRow, since: number | null): void {
  const next = since ?? 0;
  const current = account.backfilledSince;
  if (current !== null && current <= next) return;
  db.update(accounts).set({ backfilledSince: next }).where(eq(accounts.id, account.id)).run();
}
