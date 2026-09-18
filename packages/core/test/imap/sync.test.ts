import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { accountRow, testConfig, testDb } from "../helpers/db";
import { FakeImapClient, fakeMessage } from "../helpers/fakeImap";
import { backfillImapAccount, syncImapAccount } from "../../src/imap/sync";
import { AccountAuthError } from "../../src/connectors/types";
import { accounts, messages, threadOpens, threads, watermarks, type AccountRow } from "../../src/db/schema";

const testCfg = testConfig();

function seedAccount(db: ReturnType<typeof testDb>): AccountRow {
  const row = accountRow({
    id: "a1",
    provider: "imap",
    email: "me@example.com",
    kind: "gmail",
    imapHost: "imap.gmail.com",
    imapPort: 993,
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
  });
  db.insert(accounts).values(row).run();
  return row;
}

const opts = { backfillDays: 7, blocklist: new Set<string>() };

// Date headers carry whole seconds, so tests use second-aligned timestamps.
const T1 = 1_725_600_000_000;
const T2 = 1_725_600_060_000;

function watermarkFor(db: ReturnType<typeof testDb>): Record<string, { uidValidity: number; lastUid: number; lowestUid?: number }> {
  const raw = db.select().from(watermarks).where(eq(watermarks.accountId, "a1")).get()?.historyId;
  return raw ? JSON.parse(raw) : {};
}

describe("syncImapAccount", () => {
  it("backfills every folder on the first run, stores messages and threads, and records the uid watermark", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    const imap = new FakeImapClient();
    imap.add("INBOX", fakeMessage({ uid: 3, from: "Bob <bob@example.com>", date: T1, gmailThreadId: "t1" }));
    imap.add("[Gmail]/Sent Mail", fakeMessage({ uid: 9, from: "me@example.com", date: T2, gmailThreadId: "t1" }));
    imap.add("[Gmail]/Trash", fakeMessage({ uid: 4, from: "old@example.com", date: T1, gmailThreadId: "t2" }));
    imap.add("[Gmail]/Spam", fakeMessage({ uid: 5, from: "spam@example.com", date: T1, gmailThreadId: "t3" }));

    const r = await syncImapAccount(db, testCfg, imap, acct, { ...opts, clock: () => 1_000 });

    expect(r).toEqual({ mode: "backfill", fetched: 4, stored: 4, blocked: 0, failed: 0 });
    expect(imap.connects).toBe(1);
    expect(imap.closes).toBe(1);
    // A backfill asks for a window, not a uid range.
    expect(imap.fetchCalls.every((c) => c.afterUid === null && c.sinceDate instanceof Date)).toBe(true);
    expect(imap.fetchCalls[0]?.sinceDate?.getTime()).toBe(1_000 - 7 * 86_400_000);

    const stored = db.select().from(messages).all();
    expect(stored.map((m) => m.id).sort()).toEqual([
      "a1:INBOX:3",
      "a1:[Gmail]/Sent Mail:9",
      "a1:[Gmail]/Spam:5",
      "a1:[Gmail]/Trash:4",
    ]);
    expect(stored.find((m) => m.providerMessageId === "[Gmail]/Sent Mail:9")?.isFromOperator).toBe(true);
    expect(stored.find((m) => m.providerMessageId === "INBOX:3")?.isFromOperator).toBe(false);
    // Each message carries the folder it came from (spec 10a).
    expect(Object.fromEntries(stored.map((m) => [m.providerMessageId, m.folder]))).toEqual({
      "INBOX:3": "inbox",
      "[Gmail]/Sent Mail:9": "sent",
      "[Gmail]/Trash:4": "trash",
      "[Gmail]/Spam:5": "junk",
    });

    const thread = db.select().from(threads).where(eq(threads.id, "a1:t1")).get();
    expect(thread?.lastMessageAt).toBe(T2);
    expect(thread?.lastFromOperator).toBe(true);

    expect(watermarkFor(db)).toEqual({
      inbox: { uidValidity: 1, lastUid: 3, lowestUid: 3 },
      sent: { uidValidity: 1, lastUid: 9, lowestUid: 9 },
      trash: { uidValidity: 1, lastUid: 4, lowestUid: 4 },
      junk: { uidValidity: 1, lastUid: 5, lowestUid: 5 },
    });
  });

  it("fetches only newer uids on later runs and is idempotent", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    const imap = new FakeImapClient();
    imap.add("INBOX", fakeMessage({ uid: 3, from: "bob@example.com", date: T1 }));
    await syncImapAccount(db, testCfg, imap, acct, opts);

    imap.add("INBOX", fakeMessage({ uid: 4, from: "bob@example.com", date: T2, messageId: "<m4@x>" }));
    const second = await syncImapAccount(db, testCfg, imap, acct, opts);

    expect(second.mode).toBe("history");
    expect(second.stored).toBe(1);
    expect(imap.fetchCalls.find((c) => c.folder === "INBOX" && c.afterUid !== null)).toMatchObject({ folder: "INBOX", afterUid: 3, sinceDate: null });
    expect(db.select().from(messages).all()).toHaveLength(2);
    expect(watermarkFor(db).inbox).toEqual({ uidValidity: 1, lastUid: 4, lowestUid: 3 });
  });

  it("ignores the n:* quirk: a server that re-sends the last message stores nothing and leaves the watermark alone", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    const imap = new FakeImapClient();
    imap.add("INBOX", fakeMessage({ uid: 3, from: "bob@example.com", date: T1 }));
    await syncImapAccount(db, testCfg, imap, acct, opts);

    const second = await syncImapAccount(db, testCfg, imap, acct, opts);

    expect(second.mode).toBe("history");
    expect(second.stored).toBe(0);
    expect(second.fetched).toBe(0);
    expect(db.select().from(messages).all()).toHaveLength(1);
    expect(watermarkFor(db).inbox).toEqual({ uidValidity: 1, lastUid: 3, lowestUid: 3 });
  });

  it("re-backfills a folder whose uidValidity changed, and does not store the stale-uid fetch", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    const imap = new FakeImapClient();
    imap.add("INBOX", fakeMessage({ uid: 3, from: "bob@example.com", date: T1 }));
    await syncImapAccount(db, testCfg, imap, acct, opts);

    imap.resetUidValidity("INBOX", 2);
    imap.folderState.get("INBOX")!.messages = [fakeMessage({ uid: 1, from: "carol@example.com", date: T2, messageId: "<c1@x>" })];
    const second = await syncImapAccount(db, testCfg, imap, acct, opts);

    expect(second.mode).toBe("backfill");
    expect(second.stored).toBe(1);
    expect(watermarkFor(db).inbox).toEqual({ uidValidity: 2, lastUid: 1, lowestUid: 1 });
    expect(db.select().from(messages).all().map((m) => m.fromAddress).sort()).toEqual(["bob@example.com", "carol@example.com"]);
  });

  it("never stores a blocked sender", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    const imap = new FakeImapClient();
    imap.add("INBOX", fakeMessage({ uid: 1, from: "Spam <spam@example.com>" }), fakeMessage({ uid: 2, from: "bob@example.com", messageId: "<b@x>" }));

    const r = await syncImapAccount(db, testCfg, imap, acct, { ...opts, blocklist: new Set(["spam@example.com"]) });

    expect(r.blocked).toBe(1);
    expect(db.select().from(messages).all().map((m) => m.fromAddress)).toEqual(["bob@example.com"]);
    expect(watermarkFor(db).inbox?.lastUid).toBe(2);
  });

  it("counts a message that fails to parse and keeps going", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    const imap = new FakeImapClient();
    imap.add(
      "INBOX",
      { uid: 1, source: null as unknown as Buffer },
      fakeMessage({ uid: 2, from: "bob@example.com", messageId: "<b@x>" }),
    );

    const r = await syncImapAccount(db, testCfg, imap, acct, opts);

    expect(r.failed).toBe(1);
    expect(r.stored).toBe(1);
    expect(db.select().from(messages).all().map((m) => m.providerMessageId)).toEqual(["INBOX:2"]);
    expect(watermarkFor(db).inbox?.lastUid).toBe(2);
  });

  it("syncs the inbox alone when the server reports no other special-use folders", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    const imap = new FakeImapClient();
    imap.sentPath = null;
    imap.trashPath = null;
    imap.junkPath = null;
    imap.add("INBOX", fakeMessage({ uid: 1, from: "bob@example.com" }));

    const r = await syncImapAccount(db, testCfg, imap, acct, opts);

    expect(r.fetched).toBe(1);
    expect(watermarkFor(db)).toEqual({ inbox: { uidValidity: 1, lastUid: 1, lowestUid: 1 } });
  });

  it("closes the connection even when a fetch throws", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    const imap = new FakeImapClient();
    imap.fetchNew = async () => {
      throw new Error("network reset");
    };

    await expect(syncImapAccount(db, testCfg, imap, acct, opts)).rejects.toThrow(/network reset/);
    expect(imap.closes).toBe(1);
  });

  it("turns an IMAP login failure into AccountAuthError so the account is flagged for re-signin", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    const imap = new FakeImapClient();
    imap.connectError = Object.assign(new Error("Invalid credentials (Failure)"), { authenticationFailed: true });

    await expect(syncImapAccount(db, testCfg, imap, acct, opts)).rejects.toThrow(AccountAuthError);
  });

  it("does not wrap an unrelated failure as AccountAuthError", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    const imap = new FakeImapClient();
    imap.connectError = new Error("ETIMEDOUT");

    await expect(syncImapAccount(db, testCfg, imap, acct, opts)).rejects.not.toBeInstanceOf(AccountAuthError);
  });
});

describe("backfillImapAccount", () => {
  const DAY = 86_400_000;
  const backfillOpts = (to: number | null) => ({ to, blocklist: new Set<string>(), clock: () => T1 });

  function reload(db: ReturnType<typeof testDb>): AccountRow {
    return db.select().from(accounts).where(eq(accounts.id, "a1")).get()!;
  }

  /** An account synced once, holding uid 3 in INBOX, with uid 1 and 2 older and unseen. */
  async function synced(db: ReturnType<typeof testDb>): Promise<{ imap: FakeImapClient; account: AccountRow }> {
    const acct = seedAccount(db);
    const imap = new FakeImapClient();
    imap.add("INBOX", fakeMessage({ uid: 3, from: "bob@example.com", date: T1 }));
    await syncImapAccount(db, testCfg, imap, acct, { ...opts, clock: () => T1 });
    imap.folderState.get("INBOX")!.messages.unshift(
      fakeMessage({ uid: 1, from: "ancient@example.com", date: T1 - 100 * DAY, messageId: "<u1@x>" }),
      fakeMessage({ uid: 2, from: "old@example.com", date: T1 - 20 * DAY, messageId: "<u2@x>" }),
    );
    return { imap, account: reload(db) };
  }

  it("fetches only uids below the stored floor and inside the window, and leaves lastUid alone", async () => {
    const db = testDb();
    const { imap, account } = await synced(db);

    const r = await backfillImapAccount(db, testCfg, imap, account, backfillOpts(T1 - 30 * DAY));

    expect(r).toEqual({ mode: "backfill", fetched: 1, stored: 1, blocked: 0, failed: 0 });
    expect(imap.olderCalls[0]).toMatchObject({ folder: "INBOX", beforeUid: 3 });
    expect(imap.olderCalls[0]?.sinceDate?.getTime()).toBe(T1 - 30 * DAY);
    expect(db.select().from(messages).all().map((m) => m.id).sort()).toEqual(["a1:INBOX:2", "a1:INBOX:3"]);
    expect(watermarkFor(db).inbox).toMatchObject({ uidValidity: 1, lastUid: 3, lowestUid: 2 });
    expect(reload(db).backfilledSince).toBe(T1 - 30 * DAY);
  });

  it("fetches nothing new on a second backfill to the same depth", async () => {
    const db = testDb();
    const { imap, account } = await synced(db);
    await backfillImapAccount(db, testCfg, imap, account, backfillOpts(T1 - 30 * DAY));
    const callsAfterFirst = imap.olderCalls.length;

    const second = await backfillImapAccount(db, testCfg, imap, reload(db), backfillOpts(T1 - 30 * DAY));

    expect(second).toEqual({ mode: "backfill", fetched: 0, stored: 0, blocked: 0, failed: 0 });
    expect(imap.olderCalls.length).toBeGreaterThan(callsAfterFirst); // it asks; the floor just leaves nothing
    expect(db.select().from(messages).all()).toHaveLength(2);
    expect(watermarkFor(db).inbox).toMatchObject({ lastUid: 3, lowestUid: 2 });
  });

  it("takes the whole mailbox when the depth is null and records depth 0", async () => {
    const db = testDb();
    const { imap, account } = await synced(db);

    const r = await backfillImapAccount(db, testCfg, imap, account, backfillOpts(null));

    expect(imap.olderCalls[0]).toMatchObject({ folder: "INBOX", beforeUid: 3, sinceDate: null });
    expect(r.stored).toBe(2);
    expect(db.select().from(messages).all()).toHaveLength(3);
    expect(watermarkFor(db).inbox).toMatchObject({ lastUid: 3, lowestUid: 1 });
    expect(reload(db).backfilledSince).toBe(0);
  });

  it("derives the floor from stored messages when the watermark predates lowestUid", async () => {
    const db = testDb();
    const { imap, account } = await synced(db);
    // A watermark written before this feature existed: no lowestUid at all.
    db.update(watermarks)
      .set({ historyId: JSON.stringify({ inbox: { uidValidity: 1, lastUid: 3 } }) })
      .where(eq(watermarks.accountId, "a1"))
      .run();

    await backfillImapAccount(db, testCfg, imap, account, backfillOpts(null));

    expect(imap.olderCalls[0]).toMatchObject({ folder: "INBOX", beforeUid: 3 });
    expect(db.select().from(messages).all()).toHaveLength(3);
  });

  it("never stores a blocked sender", async () => {
    const db = testDb();
    const { imap, account } = await synced(db);

    const r = await backfillImapAccount(db, testCfg, imap, account, {
      to: null,
      blocklist: new Set(["ancient@example.com"]),
      clock: () => T1,
    });

    expect(r).toMatchObject({ stored: 1, blocked: 1 });
    expect(db.select().from(messages).all().map((m) => m.fromAddress)).not.toContain("ancient@example.com");
  });

  it("reports a login failure as an AccountAuthError", async () => {
    const db = testDb();
    const { imap, account } = await synced(db);
    imap.connectError = Object.assign(new Error("Invalid credentials"), { authenticationFailed: true });

    await expect(backfillImapAccount(db, testCfg, imap, account, backfillOpts(null))).rejects.toBeInstanceOf(AccountAuthError);
  });
});

/**
 * What the server says the operator has read (2026-09-14): \\Seen at store
 * time opens the thread up to that message, and the flags of the last week's
 * inbox mail are read again on every sync for what was read on the phone.
 */
describe("read flags", () => {
  const opens = (db: ReturnType<typeof testDb>) => Object.fromEntries(db.select().from(threadOpens).all().map((r) => [r.threadId, r.openedAt]));

  it("a message already \\Seen arrives opened; one unseen arrives unopened", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    const imap = new FakeImapClient();
    imap.add("INBOX", fakeMessage({ uid: 3, from: "bob@example.com", date: T1, gmailThreadId: "t1", seen: true }));
    imap.add("INBOX", fakeMessage({ uid: 4, from: "carol@example.com", date: T1, gmailThreadId: "t2", seen: false }));
    imap.add("INBOX", fakeMessage({ uid: 5, from: "dave@example.com", date: T1, gmailThreadId: "t3" }));
    await syncImapAccount(db, testCfg, imap, acct, { ...opts, clock: () => T1 + 1_000 });
    expect(opens(db)).toEqual({ "a1:t1": T1 });
  });

  it("reads the flags of recent inbox mail again, and opens what was read since", async () => {
    const db = testDb();
    const acct = seedAccount(db);
    const imap = new FakeImapClient();
    imap.add("INBOX", fakeMessage({ uid: 3, from: "bob@example.com", date: T1, gmailThreadId: "t1", seen: false }));
    // Old mail is not asked about again.
    imap.add("INBOX", fakeMessage({ uid: 2, from: "old@example.com", date: T1 - 30 * 86_400_000, gmailThreadId: "t0", seen: false }));
    await syncImapAccount(db, testCfg, imap, acct, { ...opts, backfillTo: null, clock: () => T1 + 1_000 });
    expect(opens(db)).toEqual({});

    imap.markSeen("INBOX", 3);
    imap.markSeen("INBOX", 2);
    await syncImapAccount(db, testCfg, imap, acct, { ...opts, clock: () => T1 + 2_000 });
    expect(imap.flagCalls.at(-1)).toEqual({ folder: "INBOX", uids: [3] });
    expect(opens(db)).toEqual({ "a1:t1": T1 });
  });
});
