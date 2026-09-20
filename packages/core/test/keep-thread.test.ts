import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { accountRow, testDb } from "./helpers/db";
import { keepThread } from "../src/queue/inbox";
import { accounts, actions, messages, sorts, threads, type NewMessageRow, type Wants } from "../src/db/schema";

/**
 * Taking a thread out of Safe to delete (operator, 2026-09-18: "move a mail
 * from Safe to delete").
 *
 * The verdict is written per message and the list is drawn per thread, so
 * these tests care most about the thread with more than one message in it:
 * clearing the newest alone leaves the thread on the list behind the older
 * one, which is the whole bug this function exists to avoid.
 */
type Row = Partial<NewMessageRow> & { id: string; threadId: string; sentAt: number };

function seed(db: ReturnType<typeof testDb>, rows: Row[], verdicts: Record<string, { wants: Wants }>): void {
  db.insert(accounts).values(accountRow({ id: "a1", provider: "imap", email: "me@example.com" })).run();
  for (const threadId of new Set(rows.map((r) => r.threadId))) {
    db.insert(threads).values({ id: threadId, accountId: "a1", providerThreadId: threadId, subject: "s", lastMessageAt: 1, lastFromOperator: false }).run();
  }
  for (const r of rows) {
    db.insert(messages)
      .values({
        accountId: "a1",
        providerMessageId: r.id,
        rfcMessageId: null,
        fromAddress: "bob@example.com",
        fromName: null,
        toAddresses: [],
        ccAddresses: [],
        subject: "s",
        bodyText: "b",
        bodyHtml: null,
        snippet: null,
        attachmentNames: [],
        isFromOperator: false,
        receivedAt: r.sentAt,
        ...r,
      })
      .run();
    const v = verdicts[r.id];
    if (v) {
      db.insert(sorts)
        .values({ messageId: r.id, wants: v.wants, scheduling: false, reason: "seed", model: "test", createdAt: 1 })
        .run();
    }
  }
}

const verdict = (db: ReturnType<typeof testDb>, id: string) => db.select().from(sorts).where(eq(sorts.messageId, id)).get();

describe("keepThread", () => {
  it("clears the verdict on every message in the thread, not only the newest", () => {
    const db = testDb();
    seed(
      db,
      [
        { id: "a1:m1", threadId: "a1:t1", sentAt: 1 },
        { id: "a1:m2", threadId: "a1:t1", sentAt: 2 },
      ],
      { "a1:m1": { wants: "bin" }, "a1:m2": { wants: "bin" } },
    );

    expect(keepThread(db, "a1:t1")).toBe(2);
    expect(verdict(db, "a1:m1")?.wants).not.toBe("bin");
    expect(verdict(db, "a1:m2")?.wants).not.toBe("bin");
  });

  it("leaves another thread's verdict alone", () => {
    const db = testDb();
    seed(
      db,
      [
        { id: "a1:m1", threadId: "a1:t1", sentAt: 1 },
        { id: "a1:m2", threadId: "a1:t2", sentAt: 1 },
      ],
      { "a1:m1": { wants: "bin" }, "a1:m2": { wants: "bin" } },
    );

    keepThread(db, "a1:t1");
    expect(verdict(db, "a1:m2")?.wants).toBe("bin");
  });

  it("to the inbox, it says nothing about replying", () => {
    const db = testDb();
    seed(db, [{ id: "a1:m1", threadId: "a1:t1", sentAt: 1 }], { "a1:m1": { wants: "bin" } });

    keepThread(db, "a1:t1", "inbox");
    expect(verdict(db, "a1:m1")?.wants).toBe("knowing");
  });

  it("to Need to reply, the newest message gains the verdict and only the newest", () => {
    const db = testDb();
    seed(
      db,
      [
        { id: "a1:m1", threadId: "a1:t1", sentAt: 1 },
        { id: "a1:m2", threadId: "a1:t1", sentAt: 2 },
      ],
      { "a1:m1": { wants: "bin" }, "a1:m2": { wants: "bin" } },
    );

    keepThread(db, "a1:t1", "needs_reply");
    expect(verdict(db, "a1:m2")?.wants).toBe("reply");
    expect(verdict(db, "a1:m1")?.wants).toBe("knowing");
  });

  /**
   * The Need-to-reply list passes over anything carrying a handled mark, so
   * a rescue that left one behind would have gone nowhere the operator could
   * see it.
   */
  it("to Need to reply, a handled mark on the newest message comes off", () => {
    const db = testDb();
    seed(db, [{ id: "a1:m1", threadId: "a1:t1", sentAt: 1 }], { "a1:m1": { wants: "bin" } });
    db.insert(actions).values({ kind: "handled", messageId: "a1:m1", payload: {}, createdAt: 1 }).run();

    keepThread(db, "a1:t1", "needs_reply");
    expect(db.select().from(actions).where(eq(actions.messageId, "a1:m1")).all()).toEqual([]);
  });

  it("leaves a handled mark alone when the thread is only being kept", () => {
    const db = testDb();
    seed(db, [{ id: "a1:m1", threadId: "a1:t1", sentAt: 1 }], { "a1:m1": { wants: "bin" } });
    db.insert(actions).values({ kind: "handled", messageId: "a1:m1", payload: {}, createdAt: 1 }).run();

    keepThread(db, "a1:t1", "inbox");
    expect(db.select().from(actions).where(eq(actions.messageId, "a1:m1")).all()).toHaveLength(1);
  });

  it("says nothing changed for a thread that does not exist", () => {
    const db = testDb();
    seed(db, [{ id: "a1:m1", threadId: "a1:t1", sentAt: 1 }], { "a1:m1": { wants: "bin" } });
    expect(keepThread(db, "a1:t9")).toBe(0);
  });
});
