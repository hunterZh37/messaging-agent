import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../helpers/db";
import { accounts, messages, sorts, threads } from "../../src/db/schema";
import { moveThreadsTo, restoreVerdicts } from "../../src/sort/corrections";

const base = {
  accountId: "a1", rfcMessageId: null, ccAddresses: [], bodyHtml: null,
  snippet: null, attachmentNames: [], receivedAt: 0, raw: null,
};

function seeded() {
  const db = testDb();
  db.insert(accounts).values({ id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: 1 }).run();
  return db;
}

function thread(db: ReturnType<typeof testDb>, id: string, wants: string | null) {
  db.insert(threads).values({ id: `a1:${id}`, accountId: "a1", providerThreadId: id, subject: id, lastMessageAt: 500, lastFromOperator: false }).run();
  db.insert(messages)
    .values({ ...base, id: `a1:${id}m`, providerMessageId: `INBOX:${id}`, threadId: `a1:${id}`,
      fromAddress: "them@example.com", toAddresses: ["me@example.com"], subject: id, bodyText: "x",
      isFromOperator: false, folder: "inbox", sentAt: 500 })
    .run();
  if (wants) {
    db.insert(sorts).values({ messageId: `a1:${id}m`, wants: wants as never, scheduling: false, category: "Needs reply", finance: "none", reason: "she asked", model: "sorter-v2", labeledAt: 7, createdAt: 1 }).run();
  }
}

const wantsOf = (db: ReturnType<typeof testDb>, id: string) =>
  db.select().from(sorts).where(eq(sorts.messageId, id)).get()?.wants ?? null;

describe("moveThreadsTo", () => {
  it("puts every thread it is given on the rung", () => {
    const db = seeded();
    thread(db, "a", "reply");
    thread(db, "b", "action");
    const r = moveThreadsTo(db, ["a1:a", "a1:b"], "knowing");
    expect(r.moved).toBe(2);
    expect(wantsOf(db, "a1:am")).toBe("knowing");
    expect(wantsOf(db, "a1:bm")).toBe("knowing");
  });

  it("gives back what each said before, which is the undo", () => {
    const db = seeded();
    thread(db, "a", "reply");
    thread(db, "b", "action");
    const r = moveThreadsTo(db, ["a1:a", "a1:b"], "knowing");
    restoreVerdicts(db, r.previous);
    // Each goes back to its own rung, not to one the batch shared.
    expect(wantsOf(db, "a1:am")).toBe("reply");
    expect(wantsOf(db, "a1:bm")).toBe("action");
  });

  it("restores the reason and the model, so an undone move leaves no trace of itself", () => {
    const db = seeded();
    thread(db, "a", "reply");
    const r = moveThreadsTo(db, ["a1:a"], "knowing");
    expect(db.select().from(sorts).where(eq(sorts.messageId, "a1:am")).get()?.model).toBe("operator");
    restoreVerdicts(db, r.previous);
    const back = db.select().from(sorts).where(eq(sorts.messageId, "a1:am")).get();
    expect(back?.model).toBe("sorter-v2");
    expect(back?.reason).toBe("she asked");
    expect(back?.category).toBe("Needs reply");
  });

  it("undoes a message the sorter had never judged by removing the verdict, not inventing one", () => {
    const db = seeded();
    thread(db, "fresh", null);
    const r = moveThreadsTo(db, ["a1:fresh"], "knowing");
    expect(wantsOf(db, "a1:freshm")).toBe("knowing");
    restoreVerdicts(db, r.previous);
    expect(wantsOf(db, "a1:freshm")).toBe(null);
  });

  it("does nothing for an empty list", () => {
    const db = seeded();
    expect(moveThreadsTo(db, [], "knowing")).toEqual({ moved: 0, previous: [] });
  });
});
