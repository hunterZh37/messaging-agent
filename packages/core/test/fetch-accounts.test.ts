import { describe, it, expect } from "vitest";
import { accountRow, testDb } from "./helpers/db";
import { accounts } from "../src/db/schema";
import { fetchAccounts } from "../src/pipeline";
import { AccountAuthError } from "../src/connectors/types";
import type { MailConnector } from "../src/connectors/types";

/**
 * Several inboxes at once (operator, 2026-09-18: "the sync takes forever").
 *
 * This was a loop with an await in it, so seven inboxes cost the sum of
 * seven waits rather than the longest of them. These tests pin the two
 * things that made it safe to change: every account is still fetched, and a
 * broken one still cannot take the others down with it.
 */
function seed(db: ReturnType<typeof testDb>, n: number): void {
  for (let i = 0; i < n; i++) {
    db.insert(accounts).values(accountRow({ id: `a${i}`, provider: "imap", email: `a${i}@example.com` })).run();
  }
}

/** A connector that takes a tick to answer, and records how many are in flight while it does. */
function watched(peak: { now: number; most: number }, behaviour: (id: string) => Promise<void> = async () => {}) {
  return (id: string): MailConnector =>
    ({
      async sync() {
        peak.now += 1;
        peak.most = Math.max(peak.most, peak.now);
        try {
          await new Promise((r) => setTimeout(r, 5));
          await behaviour(id);
          return { mode: "history", fetched: 1, stored: 1, blocked: 0, failed: 0 };
        } finally {
          peak.now -= 1;
        }
      },
    }) as unknown as MailConnector;
}

describe("fetchAccounts", () => {
  it("fetches every account, and says so for each", async () => {
    const db = testDb();
    seed(db, 6);
    const peak = { now: 0, most: 0 };
    const make = watched(peak);
    const out = await fetchAccounts(db, { connectorFor: (a) => make(a.id), backfillDays: 7, blocklist: { addresses: [], domains: [] } as never }, undefined);
    expect(out).toHaveLength(6);
    expect(out.every((e) => e.result.sync?.stored === 1)).toBe(true);
  });

  it("has more than one in flight at a time, which is the whole point", async () => {
    const db = testDb();
    seed(db, 6);
    const peak = { now: 0, most: 0 };
    const make = watched(peak);
    await fetchAccounts(db, { connectorFor: (a) => make(a.id), backfillDays: 7, blocklist: { addresses: [], domains: [] } as never }, undefined);
    expect(peak.most).toBeGreaterThan(1);
  });

  /** A provider that sees every mailbox opened at once is a provider that starts refusing. */
  it("never runs more than four at once, however many inboxes there are", async () => {
    const db = testDb();
    seed(db, 12);
    const peak = { now: 0, most: 0 };
    const make = watched(peak);
    await fetchAccounts(db, { connectorFor: (a) => make(a.id), backfillDays: 7, blocklist: { addresses: [], domains: [] } as never }, undefined);
    expect(peak.most).toBeLessThanOrEqual(4);
  });

  it("carries on when one account throws, and records the reason on that one only", async () => {
    const db = testDb();
    seed(db, 5);
    const peak = { now: 0, most: 0 };
    const make = watched(peak, async (id) => {
      if (id === "a2") throw new Error("imap said no");
    });
    const out = await fetchAccounts(db, { connectorFor: (a) => make(a.id), backfillDays: 7, blocklist: { addresses: [], domains: [] } as never }, undefined);
    const bad = out.find((e) => e.account.id === "a2");
    expect(bad?.result.syncError).toBe("imap said no");
    expect(out.filter((e) => e.result.sync?.stored === 1)).toHaveLength(4);
  });

  it("marks an account that needs signing in again, and only that one", async () => {
    const db = testDb();
    seed(db, 3);
    const peak = { now: 0, most: 0 };
    const make = watched(peak, async (id) => {
      if (id === "a1") throw new AccountAuthError(id, "token expired");
    });
    await fetchAccounts(db, { connectorFor: (a) => make(a.id), backfillDays: 7, blocklist: { addresses: [], domains: [] } as never }, undefined);
    const rows = db.select().from(accounts).all();
    expect(rows.find((r) => r.id === "a1")?.status).toBe("needs_signin");
    expect(rows.filter((r) => r.status === "ok")).toHaveLength(2);
  });

  it("fetches only the accounts it was given", async () => {
    const db = testDb();
    seed(db, 5);
    const peak = { now: 0, most: 0 };
    const make = watched(peak);
    const out = await fetchAccounts(db, { connectorFor: (a) => make(a.id), backfillDays: 7, blocklist: { addresses: [], domains: [] } as never }, ["a0", "a3"]);
    expect(out.map((e) => e.account.id).sort()).toEqual(["a0", "a3"]);
  });
});
