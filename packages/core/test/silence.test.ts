import { describe, it, expect } from "vitest";
import { accountRow, testDb } from "./helpers/db";
import { accounts, messages, watermarks, type NewMessageRow } from "../src/db/schema";
import { inboxSilences, stalledInboxes, SILENCE_FLOOR_MS } from "../src/queue/silence";

/**
 * The check written the day an inbox fetched nothing for twenty six hours
 * and reported perfect health (operator, 2026-09-18: "make the silently
 * stalled sync visible").
 */
const HOUR = 3_600_000;
const NOW = 1_789_800_000_000;

function account(db: ReturnType<typeof testDb>, id: string, provider = "imap"): void {
  db.insert(accounts).values(accountRow({ id, provider, email: `${id}@example.com` })).run();
  db.insert(watermarks).values({ accountId: id, historyId: "{}", lastSyncAt: NOW - 60_000 }).run();
}

/** `gapHours` apart, ending `quietHours` before now. */
function traffic(db: ReturnType<typeof testDb>, id: string, count: number, gapHours: number, quietHours: number): void {
  const last = NOW - quietHours * HOUR;
  for (let i = 0; i < count; i++) {
    const at = last - (count - 1 - i) * gapHours * HOUR;
    const row: NewMessageRow = {
      id: `${id}:m${i}`, accountId: id, providerMessageId: `m${i}`, threadId: `${id}:t${i}`, rfcMessageId: null,
      fromAddress: "someone@example.com", fromName: null, toAddresses: [], ccAddresses: [], subject: "s",
      bodyText: "b", bodyHtml: null, snippet: null, attachmentNames: [], isFromOperator: false,
      folder: "inbox", sentAt: at, receivedAt: at,
    };
    db.insert(messages).values(row).run();
  }
}

const of = (db: ReturnType<typeof testDb>, id: string) => inboxSilences(db, NOW).find((s) => s.accountId === id)!;

describe("an inbox gone quieter than it ever is", () => {
  /** The real shape: mail every half hour all week, then a day of nothing. */
  it("calls a busy inbox stalled after a day of silence", () => {
    const db = testDb();
    account(db, "busy");
    traffic(db, "busy", 40, 0.5, 26);
    const s = of(db, "busy");
    expect(s.typicalGapMs).toBe(0.5 * HOUR);
    expect(s.quietForMs).toBe(26 * HOUR);
    expect(s.stale).toBe(true);
    expect(stalledInboxes(db, NOW).map((x) => x.accountId)).toEqual(["busy"]);
  });

  /**
   * The failure this must not have. A fortnightly inbox is not broken for
   * being quiet for a week, and a fixed threshold would have said it was.
   */
  it("leaves a rarely-used inbox alone after the same day of silence", () => {
    const db = testDb();
    account(db, "quiet");
    traffic(db, "quiet", 12, 24 * 14, 26);
    const s = of(db, "quiet");
    expect(s.stale).toBe(false);
    expect(stalledInboxes(db, NOW)).toEqual([]);
  });

  it("says nothing about an inbox with too little history to have a habit", () => {
    const db = testDb();
    account(db, "new");
    traffic(db, "new", 3, 0.5, 400);
    const s = of(db, "new");
    expect(s.typicalGapMs).toBeNull();
    expect(s.thresholdMs).toBeNull();
    expect(s.stale).toBe(false);
  });

  it("says nothing about an inbox that has never held a message", () => {
    const db = testDb();
    account(db, "empty");
    expect(of(db, "empty").stale).toBe(false);
  });

  /** However chatty, a few hours of quiet is just a few hours of quiet. */
  it("holds its tongue below the floor, however fast the inbox usually is", () => {
    const db = testDb();
    account(db, "fast");
    traffic(db, "fast", 60, 1 / 60, 6);
    const s = of(db, "fast");
    expect(s.thresholdMs).toBe(SILENCE_FLOOR_MS);
    expect(s.quietForMs).toBeLessThan(SILENCE_FLOOR_MS);
    expect(s.stale).toBe(false);
  });

  it("reports one inbox without implicating its neighbours", () => {
    const db = testDb();
    account(db, "busy");
    account(db, "fine");
    traffic(db, "busy", 40, 0.5, 26);
    traffic(db, "fine", 40, 0.5, 0.25);
    expect(stalledInboxes(db, NOW).map((x) => x.accountId)).toEqual(["busy"]);
  });

  /** Chats are watched by something else and keep their own hours. */
  it("passes over chat accounts entirely", () => {
    const db = testDb();
    account(db, "chat", "whatsapp");
    traffic(db, "chat", 40, 0.5, 400);
    expect(inboxSilences(db, NOW).map((s) => s.accountId)).not.toContain("chat");
  });

  it("carries when the sync last ran, so a stall reads apart from a sync that stopped", () => {
    const db = testDb();
    account(db, "busy");
    traffic(db, "busy", 40, 0.5, 26);
    expect(of(db, "busy").lastSyncAt).toBe(NOW - 60_000);
  });

  /** The operator's own mail says nothing about whether anyone is writing in. */
  it("counts only what arrived, not what was sent", () => {
    const db = testDb();
    account(db, "busy");
    traffic(db, "busy", 40, 0.5, 26);
    db.update(messages).set({ isFromOperator: true }).where(undefined).run();
    expect(of(db, "busy").stale).toBe(false);
  });
});
