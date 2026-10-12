import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../helpers/db";
import { accounts, messages, sorts, threadOpens, threads } from "../../src/db/schema";
import { sweepable, sweepableAmong, sweepWorthKnowing, SWEEP_QUIET_DAYS } from "../../src/queue/sweep";
import { unhideThreads } from "../../src/queue/trash";

/**
 * Moving what has gone quiet out of working memory (operator, 2026-10-12:
 * "Inbox is like RAM and Archive is like SSD"). The rule that matters most is
 * the one that holds things back: "I want to have the confidence that I have
 * personally seen every single email out there", so nothing unopened ever
 * goes, however old and however unimportant.
 */

const DAY = 86_400_000;
const NOW = 1_000 * DAY;

const base = {
  accountId: "a1",
  rfcMessageId: null,
  ccAddresses: [],
  bodyHtml: null,
  snippet: null,
  attachmentNames: [],
  receivedAt: 0,
  raw: null,
};

/** One thread, one inbox message, with the verdict and the dates the test cares about. */
function thread(
  db: ReturnType<typeof testDb>,
  id: string,
  opts: { wants?: string; quietDays?: number; opened?: boolean; folder?: string },
) {
  const at = NOW - (opts.quietDays ?? 0) * DAY;
  db.insert(threads).values({ id: `a1:${id}`, accountId: "a1", providerThreadId: id, subject: id, lastMessageAt: at, lastFromOperator: false }).run();
  db.insert(messages)
    .values({
      ...base,
      id: `a1:${id}m`,
      providerMessageId: `INBOX:${id}`,
      threadId: `a1:${id}`,
      fromAddress: "them@example.com",
      toAddresses: ["me@example.com"],
      subject: id,
      bodyText: "body",
      isFromOperator: false,
      folder: (opts.folder ?? "inbox") as "inbox",
      sentAt: at,
    })
    .run();
  if (opts.wants) {
    db.insert(sorts).values({ messageId: `a1:${id}m`, wants: opts.wants as "knowing", scheduling: false, category: "FYI", reason: "", model: "test", sortedAt: at, createdAt: at }).run();
  }
  if (opts.opened !== false) db.insert(threadOpens).values({ threadId: `a1:${id}`, openedAt: at }).run();
}

function seeded() {
  const db = testDb();
  db.insert(accounts).values({ id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: 1 }).run();
  return db;
}

describe("sweepable", () => {
  /** The guarantee the whole design rests on. */
  it("never returns a thread the operator has not opened, however quiet", () => {
    const db = seeded();
    thread(db, "unseen", { wants: "knowing", quietDays: 400, opened: false });
    expect(sweepable(db, { now: () => NOW })).toEqual([]);
  });

  /**
   * The guarantee again, and the way it actually breaks: a thread opened last
   * year is not a thread they have read. Mail that arrived after the last time
   * they looked is unseen, and the sidebar's own Unopened row already says so
   * (review, 2026-10-12 — the first version of this checked only that a
   * `thread_opens` row existed).
   */
  it("never returns a thread whose newest mail arrived after they last looked", () => {
    const db = seeded();
    thread(db, "stale", { wants: "knowing", quietDays: 40 });
    // They opened it 40 days ago; something arrived 30 days ago that they have
    // never seen. Quiet for a fortnight, and unread.
    db.insert(messages)
      .values({ ...base, id: "a1:stalem2", providerMessageId: "INBOX:stale2", threadId: "a1:stale", fromAddress: "them@example.com", toAddresses: ["me@example.com"], subject: "stale", bodyText: "unseen", isFromOperator: false, folder: "inbox", sentAt: NOW - 30 * DAY })
      .run();
    db.insert(sorts).values({ messageId: "a1:stalem2", wants: "knowing", scheduling: false, category: "FYI", reason: "", model: "test", sortedAt: 1, createdAt: 1 }).run();
    db.update(threads).set({ lastMessageAt: NOW - 30 * DAY }).where(eq(threads.id, "a1:stale")).run();
    expect(sweepable(db, { now: () => NOW })).toEqual([]);
  });

  /** Their own word arriving after the open does not make the thread unread. */
  it("still returns one whose only later message is their own reply", () => {
    const db = seeded();
    thread(db, "mine", { wants: "knowing", quietDays: 40 });
    db.insert(messages)
      .values({ ...base, id: "a1:minem2", providerMessageId: "SENT:1", threadId: "a1:mine", fromAddress: "me@example.com", toAddresses: ["them@example.com"], subject: "mine", bodyText: "ok", isFromOperator: true, folder: "sent", sentAt: NOW - 30 * DAY })
      .run();
    db.update(threads).set({ lastMessageAt: NOW - 30 * DAY }).where(eq(threads.id, "a1:mine")).run();
    expect(sweepable(db, { now: () => NOW })).toEqual(["a1:mine"]);
  });

  /**
   * Found in their real mailbox by the review: a thread whose newest inbox
   * message the sorter has never judged, sitting on top of an older `knowing`.
   * The verdict was being read from the older one.
   */
  it("never returns a thread whose newest message has no verdict at all", () => {
    const db = seeded();
    thread(db, "unsorted", { wants: "knowing", quietDays: 40 });
    db.insert(messages)
      .values({ ...base, id: "a1:unsortedm2", providerMessageId: "INBOX:uns2", threadId: "a1:unsorted", fromAddress: "them@example.com", toAddresses: ["me@example.com"], subject: "unsorted", bodyText: "never judged", isFromOperator: false, folder: "inbox", sentAt: NOW - 35 * DAY })
      .run();
    // They have seen it; it simply has no sorts row.
    db.update(threads).set({ lastMessageAt: NOW - 35 * DAY }).where(eq(threads.id, "a1:unsorted")).run();
    db.update(threadOpens).set({ openedAt: NOW - 20 * DAY }).where(eq(threadOpens.threadId, "a1:unsorted")).run();
    expect(sweepable(db, { now: () => NOW })).toEqual([]);
  });

  it("returns a quiet Worth Knowing thread they have read", () => {
    const db = seeded();
    thread(db, "old", { wants: "knowing", quietDays: 30 });
    expect(sweepable(db, { now: () => NOW })).toEqual(["a1:old"]);
  });

  it("takes a thread from this morning, if they have read it", () => {
    const db = seeded();
    thread(db, "fresh", { wants: "knowing", quietDays: 1 });
    expect(sweepable(db, { now: () => NOW })).toEqual(["a1:fresh"]);
  });

  it("holds a thread back when a window is asked for and it is too recent", () => {
    const db = seeded();
    thread(db, "fresh", { wants: "knowing", quietDays: 1 });
    expect(sweepable(db, { days: 14, now: () => NOW })).toEqual([]);
  });

  it("counts the days from the thread, not any message, when a window is asked for", () => {
    const db = seeded();
    thread(db, "revived", { wants: "knowing", quietDays: 0 });
    // Its message is ancient; the thread is not.
    db.update(messages).set({ sentAt: NOW - 400 * DAY }).where(eq(messages.id, "a1:revivedm")).run();
    expect(sweepable(db, { days: 14, now: () => NOW })).toEqual([]);
  });

  it("never returns a thread whose newest message wants a reply", () => {
    const db = seeded();
    thread(db, "live", { wants: "reply", quietDays: 90 });
    expect(sweepable(db, { now: () => NOW })).toEqual([]);
  });

  it("reads the newest message, not the oldest", () => {
    const db = seeded();
    thread(db, "mixed", { wants: "knowing", quietDays: 90 });
    // A newer message in the same thread that needs a reply: the thread is live.
    db.insert(messages)
      .values({ ...base, id: "a1:mixedm2", providerMessageId: "INBOX:mixed2", threadId: "a1:mixed", fromAddress: "them@example.com", toAddresses: ["me@example.com"], subject: "mixed", bodyText: "b", isFromOperator: false, folder: "inbox", sentAt: NOW - 89 * DAY })
      .run();
    db.insert(sorts).values({ messageId: "a1:mixedm2", wants: "reply", scheduling: false, category: "Needs reply", reason: "", model: "test", sortedAt: 1, createdAt: 1 }).run();
    expect(sweepable(db, { now: () => NOW })).toEqual([]);
  });

  it("ignores a thread already archived", () => {
    const db = seeded();
    thread(db, "gone", { wants: "knowing", quietDays: 90 });
    db.update(threads).set({ hiddenAt: 1 }).where(eq(threads.id, "a1:gone")).run();
    expect(sweepable(db, { now: () => NOW })).toEqual([]);
  });

  it("ignores mail that is not in the inbox", () => {
    const db = seeded();
    thread(db, "sentone", { wants: "knowing", quietDays: 90, folder: "sent" });
    expect(sweepable(db, { now: () => NOW })).toEqual([]);
  });

  /**
   * What they actually asked for, twice: "a button where I can just one-click
   * and archive everything" (2026-10-12). Age stops being a condition; being
   * seen does not.
   */
  it("takes everything they have read when no window is given", () => {
    const db = seeded();
    thread(db, "today", { wants: "knowing", quietDays: 0 });
    thread(db, "lastweek", { wants: "knowing", quietDays: 6 });
    thread(db, "ancient", { wants: "knowing", quietDays: 300 });
    expect(sweepable(db, { now: () => NOW }).sort()).toEqual(["a1:ancient", "a1:lastweek", "a1:today"]);
  });

  it("still never takes one they have not opened, however the window is set", () => {
    const db = seeded();
    thread(db, "unseen", { wants: "knowing", quietDays: 0, opened: false });
    expect(sweepable(db, { now: () => NOW })).toEqual([]);
    expect(sweepable(db, { days: 0, now: () => NOW })).toEqual([]);
    expect(sweepable(db, { days: 365, now: () => NOW })).toEqual([]);
  });

  it("takes the quiet window from the caller", () => {
    const db = seeded();
    thread(db, "tenday", { wants: "knowing", quietDays: 10 });
    expect(sweepable(db, { days: 14, now: () => NOW })).toEqual([]);
    expect(sweepable(db, { days: 7, now: () => NOW })).toEqual(["a1:tenday"]);
  });

  it("waits for nothing by default: the button clears the row", () => {
    expect(SWEEP_QUIET_DAYS).toBe(0);
  });
});

describe("sweepWorthKnowing", () => {
  it("archives them all under one stamp, so one undo puts back exactly that sweep", () => {
    const db = seeded();
    thread(db, "a", { wants: "knowing", quietDays: 30 });
    thread(db, "b", { wants: "knowing", quietDays: 40 });
    // Archived by hand earlier, and no business of this sweep's undo.
    thread(db, "byhand", { wants: "knowing", quietDays: 50 });
    db.update(threads).set({ hiddenAt: 7 }).where(eq(threads.id, "a1:byhand")).run();

    const r = sweepWorthKnowing(db, { now: () => NOW });
    expect(r.moved).toBe(2);
    expect(r.threadIds.sort()).toEqual(["a1:a", "a1:b"]);
    const stamps = db.select({ id: threads.id, h: threads.hiddenAt }).from(threads).all();
    expect(stamps.filter((s) => s.h === r.at).map((s) => s.id).sort()).toEqual(["a1:a", "a1:b"]);

    unhideThreads(db, r.threadIds);
    // The one they archived themselves is untouched.
    expect(db.select({ h: threads.hiddenAt }).from(threads).where(eq(threads.id, "a1:byhand")).get()?.h).toBe(7);
  });

  it("moves nothing the second time", () => {
    const db = seeded();
    thread(db, "a", { wants: "knowing", quietDays: 30 });
    expect(sweepWorthKnowing(db, { now: () => NOW }).moved).toBe(1);
    expect(sweepWorthKnowing(db, { now: () => NOW }).moved).toBe(0);
  });

  it("does nothing, loudly enough to notice, when there is nothing to sweep", () => {
    const db = seeded();
    expect(sweepWorthKnowing(db, { now: () => NOW })).toEqual({ moved: 0, threadIds: [], at: 0 });
  });
});

/**
 * What the button in the list header acts on: the threads that view is
 * showing, less any the guarantee holds back. The view decides the set; the
 * guarantee decides what may leave it (operator, 2026-10-12).
 */
describe("sweepableAmong", () => {
  it("keeps only the ones they have read", () => {
    const db = seeded();
    thread(db, "read", { wants: "knowing", quietDays: 3 });
    thread(db, "unread", { wants: "knowing", quietDays: 3, opened: false });
    expect(sweepableAmong(db, ["a1:read", "a1:unread"])).toEqual(["a1:read"]);
  });

  it("never reaches outside the list it was given", () => {
    const db = seeded();
    thread(db, "shown", { wants: "knowing", quietDays: 3 });
    thread(db, "elsewhere", { wants: "knowing", quietDays: 3 });
    expect(sweepableAmong(db, ["a1:shown"])).toEqual(["a1:shown"]);
  });

  it("is empty for an empty list, without asking the database", () => {
    const db = seeded();
    thread(db, "shown", { wants: "knowing", quietDays: 3 });
    expect(sweepableAmong(db, [])).toEqual([]);
  });

  it("drops one whose newest message needs a reply, even if the list showed it", () => {
    const db = seeded();
    thread(db, "replyish", { wants: "reply", quietDays: 3 });
    expect(sweepableAmong(db, ["a1:replyish"])).toEqual([]);
  });
});
