import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { accountRow, testConfig, testDb } from "../helpers/db";
import { FakeOutlookClient, fakeGraphMessage } from "../helpers/fakeOutlook";
import { backfillOutlookAccount, syncOutlookAccount } from "../../src/outlook/sync";
import { accounts, messages, threads, watermarks, type AccountRow } from "../../src/db/schema";

const testCfg = testConfig();

function seedAccount(db: ReturnType<typeof testDb>): AccountRow {
  const row = accountRow({ id: "a1", provider: "outlook", email: "me@example.com" });
  db.insert(accounts).values(row).run();
  return row;
}

describe("syncOutlookAccount", () => {
  it("backfills inbox and sent on first run with sinceIso filters, stores messages, sets isFromOperator, writes both delta links", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    const client = new FakeOutlookClient();
    client.addMessage("inbox", fakeGraphMessage({ id: "i1", conversationId: "t1", from: "bob@example.com", date: 100 }));
    client.addMessage("sent", fakeGraphMessage({ id: "s1", conversationId: "t1", from: "me@example.com", date: 200 }));

    const result = await syncOutlookAccount(db, testCfg, client, acct, { backfillDays: 7, blocklist: new Set() });

    expect(result).toEqual({ mode: "backfill", fetched: 2, stored: 2, blocked: 0, failed: 0 });
    expect(client.lastSinceIso.inbox).not.toBeNull();
    expect(client.lastSinceIso.sent).not.toBeNull();
    const stored = db.select().from(messages).all();
    expect(stored.map((m) => m.id).sort()).toEqual(["a1:i1", "a1:s1"]);
    expect(stored.find((m) => m.id === "a1:s1")?.isFromOperator).toBe(true);
    const thread = db.select().from(threads).where(eq(threads.id, "a1:t1")).get();
    expect(thread?.lastMessageAt).toBe(200);
    const wm = db.select().from(watermarks).get();
    const parsed = JSON.parse(wm!.historyId) as { inbox: string; sent: string };
    expect(parsed.inbox).toBeTruthy();
    expect(parsed.sent).toBeTruthy();
  });

  it("takes a delta tombstone as a message gone from the folder, never as blank mail", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    const client = new FakeOutlookClient();
    client.addMessage("inbox", fakeGraphMessage({ id: "i1", conversationId: "t1", from: "bob@example.com", date: 100 }));
    await syncOutlookAccount(db, testCfg, client, acct, { backfillDays: 7, blocklist: new Set() });
    client.addMessage("inbox", { id: "i1", "@removed": { reason: "deleted" } } as never);
    client.addMessage("inbox", { id: "never-seen", "@removed": { reason: "deleted" } } as never);
    const r = await syncOutlookAccount(db, testCfg, client, acct, { backfillDays: 7, blocklist: new Set() });
    expect(r.fetched).toBe(0);
    const stored = db.select().from(messages).all();
    expect(stored.length).toBe(1);
    expect(stored[0]?.folder).toBe("trash");
  });

  it("walks Deleted items and Junk too, filing each message under its folder", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    const client = new FakeOutlookClient();
    client.addMessage("inbox", fakeGraphMessage({ id: "i1", from: "bob@example.com", date: 100 }));
    client.addMessage("trash", fakeGraphMessage({ id: "d1", from: "old@example.com", date: 120 }));
    client.addMessage("junk", fakeGraphMessage({ id: "j1", from: "spam@example.com", date: 140 }));

    const result = await syncOutlookAccount(db, testCfg, client, acct, { backfillDays: 7, blocklist: new Set() });

    expect(result.stored).toBe(3);
    const folders = Object.fromEntries(db.select().from(messages).all().map((m) => [m.id, m.folder]));
    expect(folders).toEqual({ "a1:i1": "inbox", "a1:d1": "trash", "a1:j1": "junk" });
    const parsed = JSON.parse(db.select().from(watermarks).get()!.historyId) as Record<string, string>;
    expect(parsed.trash).toBeTruthy();
    expect(parsed.junk).toBeTruthy();
  });

  it("uses stored delta links on later runs and is idempotent", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    const client = new FakeOutlookClient();
    client.addMessage("inbox", fakeGraphMessage({ id: "i1", conversationId: "t1", from: "bob@example.com", date: 100 }));
    await syncOutlookAccount(db, testCfg, client, acct, { backfillDays: 7, blocklist: new Set() });

    client.addMessage("inbox", fakeGraphMessage({ id: "i2", conversationId: "t1", from: "bob@example.com", date: 300 }));
    const second = await syncOutlookAccount(db, testCfg, client, acct, { backfillDays: 7, blocklist: new Set() });

    expect(second.mode).toBe("history");
    expect(second.stored).toBe(1);
    expect(db.select().from(messages).all()).toHaveLength(2);
    expect(db.select().from(threads).where(eq(threads.id, "a1:t1")).get()?.lastMessageAt).toBe(300);

    const third = await syncOutlookAccount(db, testCfg, client, acct, { backfillDays: 7, blocklist: new Set() });
    expect(third).toEqual({ mode: "history", fetched: 0, stored: 0, blocked: 0, failed: 0 });
    expect(db.select().from(messages).all()).toHaveLength(2);
  });

  it("resets to a fresh backfill for a folder whose delta link expired (410), and only that folder", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    const client = new FakeOutlookClient();
    client.addMessage("inbox", fakeGraphMessage({ id: "i1", conversationId: "t1", from: "bob@example.com" }));
    client.addMessage("sent", fakeGraphMessage({ id: "s1", conversationId: "t1", from: "me@example.com" }));
    await syncOutlookAccount(db, testCfg, client, acct, { backfillDays: 7, blocklist: new Set() });

    client.expireFolder("inbox");
    client.addMessage("inbox", fakeGraphMessage({ id: "i2", conversationId: "t2", from: "carol@example.com" }));
    const r = await syncOutlookAccount(db, testCfg, client, acct, { backfillDays: 7, blocklist: new Set() });

    expect(r.mode).toBe("history");
    expect(r.stored).toBe(1);
    expect(db.select().from(messages).all().map((m) => m.id).sort()).toEqual(["a1:i1", "a1:i2", "a1:s1"]);
  });

  it("never stores blocked senders, counting them separately", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    const client = new FakeOutlookClient();
    client.addMessage("inbox", fakeGraphMessage({ id: "i1", conversationId: "t1", from: "spam@example.com" }));
    client.addMessage("inbox", fakeGraphMessage({ id: "i2", conversationId: "t2", from: "bob@example.com" }));
    const r = await syncOutlookAccount(db, testCfg, client, acct, { backfillDays: 7, blocklist: new Set(["spam@example.com"]) });
    expect(r.blocked).toBe(1);
    expect(db.select().from(messages).all().map((m) => m.fromAddress)).toEqual(["bob@example.com"]);
  });

  it("counts a message that fails to normalize as failed and continues", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    const client = new FakeOutlookClient();
    const good = fakeGraphMessage({ id: "i1", conversationId: "t1", from: "bob@example.com" });
    const malformed = fakeGraphMessage({ id: "i2", conversationId: "t2", from: "carol@example.com", html: true });
    // @ts-expect-error deliberately malformed (not iterable) to force normalizeGraphMessage to throw when it walks the attachments
    malformed.attachments = { nope: true };
    client.addMessage("inbox", good);
    client.addMessage("inbox", malformed);

    const r = await syncOutlookAccount(db, testCfg, client, acct, { backfillDays: 7, blocklist: new Set() });
    expect(r.failed).toBe(1);
    expect(r.stored).toBe(1);
    expect(db.select().from(messages).all().map((m) => m.id)).toEqual(["a1:i1"]);
  });
});

describe("backfillOutlookAccount", () => {
  const DAY = 86_400_000;
  const NOW = 1_757_000_000_000;

  function reload(db: ReturnType<typeof testDb>): AccountRow {
    return db.select().from(accounts).where(eq(accounts.id, "a1")).get()!;
  }

  it("lists older mail by date, stores it, and leaves the delta links alone", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    const client = new FakeOutlookClient();
    client.addMessage("inbox", fakeGraphMessage({ id: "i1", from: "bob@example.com", date: NOW }));
    await syncOutlookAccount(db, testCfg, client, acct, { backfillDays: 7, blocklist: new Set(), clock: () => NOW });
    const links = JSON.parse(db.select().from(watermarks).get()!.historyId) as { inbox: string; sent: string };
    client.addOlderMessage("inbox", fakeGraphMessage({ id: "i0", from: "old@example.com", date: NOW - 20 * DAY }));
    client.addOlderMessage("inbox", fakeGraphMessage({ id: "i-ancient", from: "ancient@example.com", date: NOW - 100 * DAY }));

    const r = await backfillOutlookAccount(db, testCfg, client, reload(db), { to: NOW - 30 * DAY, blocklist: new Set(), clock: () => NOW });

    expect(r).toEqual({ mode: "backfill", fetched: 2, stored: 1, blocked: 0, failed: 0 });
    expect(client.listCalls[0]).toEqual({ folder: "inbox", sinceIso: new Date(NOW - 30 * DAY).toISOString() });
    expect(db.select().from(messages).all().map((m) => m.id).sort()).toEqual(["a1:i0", "a1:i1"]);
    expect(JSON.parse(db.select().from(watermarks).get()!.historyId)).toEqual(links);
    expect(reload(db).backfilledSince).toBe(NOW - 30 * DAY);
  });

  it("takes the whole mailbox when the depth is null, records depth 0, and stores nothing new on a repeat", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    const client = new FakeOutlookClient();
    client.addOlderMessage("inbox", fakeGraphMessage({ id: "i0", from: "old@example.com", date: NOW - 400 * DAY }));

    const first = await backfillOutlookAccount(db, testCfg, client, acct, { to: null, blocklist: new Set(), clock: () => NOW });
    const second = await backfillOutlookAccount(db, testCfg, client, reload(db), { to: null, blocklist: new Set(), clock: () => NOW });

    expect(client.listCalls[0]).toEqual({ folder: "inbox", sinceIso: null });
    expect(first.stored).toBe(1);
    expect(second.stored).toBe(0);
    expect(db.select().from(messages).all()).toHaveLength(1);
    expect(reload(db).backfilledSince).toBe(0);
  });

  it("never stores a blocked sender", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    const client = new FakeOutlookClient();
    client.addOlderMessage("inbox", fakeGraphMessage({ id: "i0", from: "spam@vendor.com", date: NOW - 40 * DAY }));

    const r = await backfillOutlookAccount(db, testCfg, client, acct, { to: null, blocklist: new Set(["spam@vendor.com"]), clock: () => NOW });

    expect(r).toMatchObject({ stored: 0, blocked: 1 });
    expect(db.select().from(messages).all()).toHaveLength(0);
  });
});
