import { describe, it, expect } from "vitest";
import { asc, eq } from "drizzle-orm";
import { testDb } from "../helpers/db";
import { accounts, messages, sorts } from "../../src/db/schema";
import { countUnsortedBefore, resortImportant, resortNeedsReply, resortWindow, sortOlder, sortPending } from "../../src/sort/run";
import { projectAssignments } from "../../src/db/schema";
import { createProject } from "../../src/projects/projects";
import { fileThread } from "../../src/projects/classify";
import { saveCategories, type Category } from "../../src/sort/categories";
import { NO_PROJECT, type Sorter, type SortInput, type SortProject, type SortResult } from "../../src/sort/types";

const CATEGORIES: Category[] = [
  { name: "Needs reply", description: "a real person is waiting on my answer." },
  { name: "FYI", description: "nothing for me to do." },
];

function seedCategories(db: ReturnType<typeof testDb>) {
  saveCategories(db, CATEGORIES.map((c) => ({ name: c.name, description: c.description })));
}

function seed(db: ReturnType<typeof testDb>) {
  db.insert(accounts).values({ id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: 1 }).run();
  const base = { accountId: "a1", threadId: "a1:t1", rfcMessageId: null, toAddresses: ["me@example.com"], ccAddresses: [], snippet: null, attachmentNames: [], receivedAt: 1 };
  db.insert(messages).values([
    { ...base, id: "a1:m1", providerMessageId: "m1", fromAddress: "bob@example.com", fromName: "Bob", subject: "Q", bodyText: "Can you?", isFromOperator: false, sentAt: 100 },
    { ...base, id: "a1:m2", providerMessageId: "m2", fromAddress: "me@example.com", fromName: null, subject: "Re: Q", bodyText: "Yes", isFromOperator: true, sentAt: 200 },
    { ...base, id: "a1:m3", providerMessageId: "m3", fromAddress: "news@example.com", fromName: null, subject: "Weekly", bodyText: "News", isFromOperator: false, sentAt: 300 },
  ]).run();
}

class ScriptedSorter implements Sorter {
  model = "fake";
  calls: SortInput[] = [];
  seenCategories: Category[][] = [];
  /** Every project list handed to `sort`, in order. */
  readonly seenProjects: SortProject[][] = [];
  // Scripts leave `finance`, `disposable` and `project` out unless the test is
  // about them, so they are filled the way the model would for ordinary mail:
  // no money in it, worth keeping, and belonging to no project.
  constructor(
    private script: (
      i: SortInput,
    ) => (Omit<SortResult, "finance" | "disposable" | "project"> & Partial<Pick<SortResult, "finance" | "disposable" | "project">>) | Error,
  ) {}
  async sort(_criteria: string, categories: Category[], projects: SortProject[], input: SortInput): Promise<SortResult> {
    this.calls.push(input);
    this.seenCategories.push(categories);
    this.seenProjects.push(projects);
    const r = this.script(input);
    if (r instanceof Error) throw r;
    return { finance: "none", disposable: false, project: NO_PROJECT, ...r };
  }
}

describe("sortPending", () => {
  it("sorts unsorted non-operator messages and stores results", async () => {
    const db = testDb();
    seed(db);
    seedCategories(db);
    const sorter = new ScriptedSorter((i) =>
      i.fromAddress === "bob@example.com"
        ? { important: true, needs_reply: true, scheduling: false, category: "Needs reply", reason: "asks" }
        : { important: false, needs_reply: false, scheduling: false, category: "FYI", reason: "newsletter" },
    );
    const r = await sortPending(db, sorter, "criteria");
    expect(r).toEqual({ sorted: 2, failed: 0 });
    expect(sorter.calls.map((c) => c.fromAddress).sort()).toEqual(["bob@example.com", "news@example.com"]);
    const rows = db.select().from(sorts).all();
    expect(rows.find((s) => s.messageId === "a1:m1")).toMatchObject({ important: true, needsReply: true, scheduling: false, category: "Needs reply", model: "fake" });
    expect(rows.find((s) => s.messageId === "a1:m3")?.important).toBe(false);
    expect(sorter.seenCategories[0]).toEqual(CATEGORIES);
  });

  it("keeps the verdict already there when two passes meet on one message", async () => {
    // Seen in the log, 2026-09-11: the trickle sort after a sync and a
    // re-file both read a message as unsorted, and the second insert failed
    // on the unique message id. The first verdict stands; nothing is filed twice.
    const db = testDb();
    seed(db);
    seedCategories(db);
    const first = new ScriptedSorter(() => ({ important: true, needs_reply: true, scheduling: false, category: "Needs reply", reason: "first" }));
    const second = new ScriptedSorter(() => ({ important: false, needs_reply: false, scheduling: false, category: "FYI", reason: "second" }));
    const a = sortPending(db, first, "criteria");
    const b = sortPending(db, second, "criteria");
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.failed + rb.failed).toBe(0);
    expect(ra.sorted + rb.sorted).toBe(2);
    const rows = db.select().from(sorts).all();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.reason === "first" || r.reason === "second")).toBe(true);
  });

  it("never sorts mail outside the inbox: sent, deleted items and junk are left alone", async () => {
    const db = testDb();
    seed(db);
    seedCategories(db);
    const base = { accountId: "a1", threadId: "a1:t1", rfcMessageId: null, toAddresses: ["me@example.com"], ccAddresses: [], snippet: null, attachmentNames: [], receivedAt: 1 };
    db.insert(messages)
      .values([
        { ...base, id: "a1:d1", providerMessageId: "d1", fromAddress: "old@example.com", fromName: null, subject: "Old", bodyText: "Old", isFromOperator: false, folder: "trash" as const, sentAt: 400 },
        { ...base, id: "a1:j1", providerMessageId: "j1", fromAddress: "spam@example.com", fromName: null, subject: "Prize", bodyText: "You won", isFromOperator: false, folder: "junk" as const, sentAt: 500 },
      ])
      .run();
    const sorter = new ScriptedSorter(() => ({ important: false, needs_reply: false, scheduling: false, category: "FYI", reason: "x" }));

    const r = await sortPending(db, sorter, "criteria");

    expect(r.sorted).toBe(2);
    expect(sorter.calls.map((c) => c.fromAddress).sort()).toEqual(["bob@example.com", "news@example.com"]);
    expect(countUnsortedBefore(db, 1_000)).toBe(0);
  });

  it("stores no category for messages that are not important", async () => {
    const db = testDb();
    seed(db);
    seedCategories(db);
    const sorter = new ScriptedSorter(() => ({ important: false, needs_reply: false, scheduling: false, category: "FYI", reason: "noise" }));
    await sortPending(db, sorter, "criteria");
    expect(db.select().from(sorts).all().map((s) => s.category)).toEqual([null, null]);
  });

  it("skips already sorted messages and counts failures without aborting", async () => {
    const db = testDb();
    seed(db);
    seedCategories(db);
    db.insert(sorts).values({ messageId: "a1:m1", important: true, needsReply: true, scheduling: false, category: "Needs reply", reason: "r", model: "x", labeledAt: null, createdAt: 1 }).run();
    const sorter = new ScriptedSorter(() => new Error("boom"));
    const r = await sortPending(db, sorter, "criteria");
    expect(r).toEqual({ sorted: 0, failed: 1 });
    expect(sorter.calls).toHaveLength(1);
  });
});

describe("resortImportant", () => {
  it("re-files important mail under the current categories, leaving importance and drafts alone", async () => {
    const db = testDb();
    seed(db);
    seedCategories(db);
    const first = new ScriptedSorter(() => ({ important: true, needs_reply: true, scheduling: false, category: "Needs reply", reason: "asks" }));
    await sortPending(db, first, "criteria");

    const second = new ScriptedSorter(() => ({ important: true, needs_reply: false, scheduling: false, category: "FYI", reason: "just news" }));
    const r = await resortImportant(db, second, "criteria");

    expect(r).toEqual({ resorted: 2, failed: 0 });
    const rows = db.select().from(sorts).all();
    expect(rows.map((s) => s.category)).toEqual(["FYI", "FYI"]);
    expect(rows.map((s) => s.reason)).toEqual(["just news", "just news"]);
    // Importance and needs_reply are what the first pass decided: drafts hang off them.
    expect(rows.every((s) => s.important && s.needsReply)).toBe(true);
    expect(second.seenCategories[0]).toEqual(CATEGORIES);
  });

  it("skips messages that are not important and counts failures without aborting", async () => {
    const db = testDb();
    seed(db);
    seedCategories(db);
    const first = new ScriptedSorter((i) => ({
      important: i.fromAddress === "bob@example.com",
      needs_reply: false,
      scheduling: false,
      category: "FYI",
      reason: "r",
    }));
    await sortPending(db, first, "criteria");

    const failing = new ScriptedSorter(() => new Error("boom"));
    expect(await resortImportant(db, failing, "criteria")).toEqual({ resorted: 0, failed: 1 });
    expect(failing.calls.map((c) => c.fromAddress)).toEqual(["bob@example.com"]);
  });
});

describe("sorting scope by age", () => {
  /** Two accounts, one message each side of the 30-day line. */
  function seedOld(db: ReturnType<typeof testDb>) {
    db.insert(accounts).values([
      { id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: 1 },
      { id: "a2", provider: "imap", email: "work@example.com", displayName: null, createdAt: 1 },
    ]).run();
    const base = { threadId: "a1:t1", rfcMessageId: null, toAddresses: ["me@example.com"], ccAddresses: [], snippet: null, attachmentNames: [], receivedAt: 1, isFromOperator: false, fromName: null };
    db.insert(messages).values([
      { ...base, id: "a1:new", accountId: "a1", providerMessageId: "new", fromAddress: "bob@example.com", subject: "New", bodyText: "recent", sentAt: 1_000 },
      { ...base, id: "a1:old", accountId: "a1", providerMessageId: "old", fromAddress: "old@example.com", subject: "Old", bodyText: "ancient", sentAt: 100 },
      { ...base, id: "a2:old", accountId: "a2", providerMessageId: "old", fromAddress: "older@example.com", subject: "Older", bodyText: "ancient", sentAt: 50 },
    ]).run();
  }

  const yes = () => new ScriptedSorter(() => ({ important: true, needs_reply: false, scheduling: false, category: "FYI", reason: "ok" }));

  it("sortPending skips messages older than minSentAt", async () => {
    const db = testDb();
    seedOld(db);
    const sorter = yes();

    const r = await sortPending(db, sorter, "criteria", { minSentAt: 500 });

    expect(r).toEqual({ sorted: 1, failed: 0 });
    expect(db.select().from(sorts).all().map((s) => s.messageId)).toEqual(["a1:new"]);
  });

  it("countUnsortedBefore counts what the automatic pass left behind", async () => {
    const db = testDb();
    seedOld(db);
    await sortPending(db, yes(), "criteria", { minSentAt: 500 });

    expect(countUnsortedBefore(db, 500)).toBe(2);
    expect(countUnsortedBefore(db, 500, { accountId: "a2" })).toBe(1);
    expect(countUnsortedBefore(db, 60)).toBe(1);
  });

  it("countUnsortedBefore ignores the operator's own messages", async () => {
    const db = testDb();
    seedOld(db);
    db.insert(messages).values({
      id: "a1:mine", accountId: "a1", providerMessageId: "mine", threadId: "a1:t1", rfcMessageId: null,
      fromAddress: "me@example.com", fromName: null, toAddresses: [], ccAddresses: [], subject: "Mine",
      bodyText: "sent", bodyHtml: null, snippet: null, attachmentNames: [], isFromOperator: true, sentAt: 90, receivedAt: 1,
    }).run();

    expect(countUnsortedBefore(db, 500)).toBe(2);
  });

  it("sortOlder sorts only the old messages, oldest first, and honours limit and accountId", async () => {
    const db = testDb();
    seedOld(db);
    await sortPending(db, yes(), "criteria", { minSentAt: 500 });
    const sorter = yes();

    const first = await sortOlder(db, sorter, "criteria", { before: 500, limit: 1 });

    expect(first).toEqual({ sorted: 1, failed: 0 });
    expect(sorter.calls.map((c) => c.subject)).toEqual(["Older"]);
    expect(countUnsortedBefore(db, 500)).toBe(1);

    const second = await sortOlder(db, sorter, "criteria", { before: 500, accountId: "a1" });
    expect(second).toEqual({ sorted: 1, failed: 0 });
    expect(countUnsortedBefore(db, 500)).toBe(0);
    expect(db.select().from(sorts).all()).toHaveLength(3);
  });

  it("sortOlder counts a per-message failure and keeps going", async () => {
    const db = testDb();
    seedOld(db);
    const sorter = new ScriptedSorter((i) =>
      i.subject === "Older" ? new Error("model down") : { important: false, needs_reply: false, scheduling: false, category: "FYI", reason: "meh" },
    );

    const r = await sortOlder(db, sorter, "criteria", { before: 500 });

    expect(r).toEqual({ sorted: 1, failed: 1 });
    expect(db.select().from(sorts).all().map((s) => s.messageId)).toEqual(["a1:old"]);
  });
});

describe("finance", () => {
  it("stores which way money moves, for important mail and for the rest", async () => {
    const db = testDb();
    seed(db);
    seedCategories(db);
    const sorter = new ScriptedSorter((i) =>
      i.subject === "Q"
        ? { important: true, needs_reply: true, scheduling: false, category: "Needs reply", finance: "expense" as const, reason: "an invoice to pay" }
        : { important: false, needs_reply: false, scheduling: false, category: "FYI", finance: "income" as const, reason: "a payout landed" },
    );

    await sortPending(db, sorter, "criteria");

    const rows = db.select().from(sorts).all();
    expect(rows.find((r) => r.messageId === "a1:m1")?.finance).toBe("expense");
    // Money is judged whether or not the message was worth surfacing.
    const quiet = rows.find((r) => r.messageId === "a1:m3");
    expect(quiet?.important).toBe(false);
    expect(quiet?.finance).toBe("income");
  });

  it("defaults to none, so mail sorted before the column existed reads as no money", async () => {
    const db = testDb();
    seed(db);
    seedCategories(db);
    await sortPending(db, new ScriptedSorter(() => ({ important: false, needs_reply: false, scheduling: false, category: "FYI", reason: "x" })), "c");
    expect(db.select().from(sorts).all().every((r) => r.finance === "none")).toBe(true);
  });
});

describe("safe to delete", () => {
  it("stores the verdict for every message, important or not", async () => {
    const db = testDb();
    seed(db);
    seedCategories(db);
    const sorter = new ScriptedSorter((i) =>
      i.subject === "Q"
        ? { important: true, needs_reply: true, scheduling: false, category: "Needs reply", disposable: false, reason: "a person asks" }
        : { important: false, needs_reply: false, scheduling: false, category: "FYI", disposable: true, reason: "a newsletter" },
    );

    await sortPending(db, sorter, "criteria");

    const rows = db.select().from(sorts).all();
    // A person wrote it, so it is kept however quiet the message was.
    expect(rows.find((r) => r.messageId === "a1:m1")?.disposable).toBe(false);
    const noise = rows.find((r) => r.messageId === "a1:m3");
    expect(noise?.important).toBe(false);
    expect(noise?.disposable).toBe(true);
  });

  it("defaults to false, so mail sorted before the column existed is never offered for deletion", async () => {
    const db = testDb();
    seed(db);
    seedCategories(db);
    await sortPending(db, new ScriptedSorter(() => ({ important: false, needs_reply: false, scheduling: false, category: "FYI", reason: "x" })), "c");
    expect(db.select().from(sorts).all().every((r) => r.disposable === false)).toBe(true);
  });

  it("is re-read by Re-sort window, which is how the operator reaches mail judged before the axis existed", async () => {
    const db = testDb();
    seed(db);
    seedCategories(db);
    await sortPending(
      db,
      new ScriptedSorter(() => ({ important: false, needs_reply: false, scheduling: false, category: "FYI", reason: "a digest" })),
      "criteria",
    );
    expect(db.select().from(sorts).all().every((r) => r.disposable === false)).toBe(true);

    const second = new ScriptedSorter(() => ({
      important: false,
      needs_reply: false,
      scheduling: false,
      category: "FYI",
      disposable: true,
      reason: "a digest, and nobody will read it twice",
    }));
    await resortWindow(db, second, "criteria", { since: 0 });
    expect(db.select().from(sorts).all().every((r) => r.disposable === true)).toBe(true);
  });
});

describe("resortWindow", () => {
  it("updates the verdict the sorter can be wrong about, and never importance", async () => {
    const db = testDb();
    seed(db);
    seedCategories(db);
    await sortPending(
      db,
      new ScriptedSorter(() => ({ important: true, needs_reply: true, scheduling: false, category: "Needs reply", reason: "asks" })),
      "criteria",
    );
    expect(db.select().from(sorts).all().every((r) => r.finance === "none")).toBe(true);

    const second = new ScriptedSorter(() => ({
      important: false,
      needs_reply: false,
      scheduling: true,
      category: "FYI",
      finance: "expense" as const,
      reason: "a bill",
    }));
    expect(await resortWindow(db, second, "criteria", { since: 0 })).toEqual({ resorted: 2, failed: 0 });

    const rows = db.select().from(sorts).all();
    expect(rows.map((r) => r.finance)).toEqual(["expense", "expense"]);
    expect(rows.map((r) => r.category)).toEqual(["FYI", "FYI"]);
    expect(rows.map((r) => r.needsReply)).toEqual([false, false]);
    expect(rows.map((r) => r.scheduling)).toEqual([true, true]);
    expect(rows.map((r) => r.reason)).toEqual(["a bill", "a bill"]);
    // The operator has already been shown these; importance is theirs to keep.
    expect(rows.every((r) => r.important)).toBe(true);
  });

  it("walks the window across presses: mail the sorter has not filed yet comes before mail it has", async () => {
    const db = testDb();
    seed(db);
    seedCategories(db);
    const sorter = new ScriptedSorter(() => ({ important: true, needs_reply: false, scheduling: false, category: "FYI", reason: "ok" }));
    await sortPending(db, sorter, "c");
    // Pretend the newer message was filed a moment ago and the older one never was.
    const older = db.select().from(messages).where(eq(messages.isFromOperator, false)).orderBy(asc(messages.sentAt)).all()[0]!;
    db.delete(projectAssignments).where(eq(projectAssignments.messageId, older.id)).run();

    const seen: string[] = [];
    const spy = new ScriptedSorter((input) => {
      seen.push(input.subject);
      return { important: true, needs_reply: false, scheduling: false, category: "FYI", reason: "ok" };
    });
    expect(await resortWindow(db, spy, "c", { since: 0, limit: 1 })).toEqual({ resorted: 1, failed: 0 });
    expect(seen).toEqual([older.subject]);
  });

  it("stays inside the window and the inbox, and counts a per-message failure", async () => {
    const db = testDb();
    seed(db);
    seedCategories(db);
    await sortPending(db, new ScriptedSorter(() => ({ important: true, needs_reply: false, scheduling: false, category: "FYI", reason: "ok" })), "c");

    // m1 is at 100 and m3 at 300; the operator's own m2 was never sorted.
    const narrow = new ScriptedSorter(() => ({ important: true, needs_reply: false, scheduling: false, category: "Needs reply", reason: "again" }));
    expect(await resortWindow(db, narrow, "c", { since: 200 })).toEqual({ resorted: 1, failed: 0 });
    expect(narrow.calls.map((c) => c.subject)).toEqual(["Weekly"]);

    const flaky = new ScriptedSorter((i) =>
      i.subject === "Q" ? new Error("model down") : { important: true, needs_reply: false, scheduling: false, category: "FYI", reason: "fine" },
    );
    expect(await resortWindow(db, flaky, "c", { since: 0 })).toEqual({ resorted: 1, failed: 1 });
  });

  it("narrows to one inbox when asked", async () => {
    const db = testDb();
    seed(db);
    seedCategories(db);
    await sortPending(db, new ScriptedSorter(() => ({ important: true, needs_reply: false, scheduling: false, category: "FYI", reason: "ok" })), "c");
    const sorter = new ScriptedSorter(() => ({ important: true, needs_reply: false, scheduling: false, category: "FYI", reason: "ok" }));
    expect(await resortWindow(db, sorter, "c", { since: 0, accountId: "a2" })).toEqual({ resorted: 0, failed: 0 });
  });
});

describe("the sorter files the project too", () => {
  function seedProjects(db: ReturnType<typeof testDb>) {
    return {
      consulting: createProject(db, "a1", "Consulting", "client work and tutoring"),
      immigration: createProject(db, "a1", "Immigration", "the trademark application"),
    };
  }

  it("hands the sorter this inbox's projects, in the operator's order", async () => {
    const db = testDb();
    seed(db);
    seedCategories(db);
    seedProjects(db);
    const sorter = new ScriptedSorter(() => ({ important: false, needs_reply: false, scheduling: false, category: "FYI", reason: "x" }));

    await sortPending(db, sorter, "criteria");

    expect(sorter.seenProjects[0]).toEqual([
      { name: "Consulting", description: "client work and tutoring" },
      { name: "Immigration", description: "the trademark application" },
    ]);
    // Read once for the run, not once per message.
    expect(sorter.seenProjects.every((p) => p === sorter.seenProjects[0])).toBe(true);
  });

  it("writes the project it names, and null for None", async () => {
    const db = testDb();
    seed(db);
    seedCategories(db);
    const { consulting } = seedProjects(db);
    const sorter = new ScriptedSorter((i) => ({
      important: false,
      needs_reply: false,
      scheduling: false,
      category: "FYI",
      project: i.subject === "Q" ? "Consulting" : "None",
      reason: "x",
    }));

    await sortPending(db, sorter, "criteria");

    const rows = Object.fromEntries(db.select().from(projectAssignments).all().map((r) => [r.messageId, r]));
    expect(rows["a1:m1"]).toMatchObject({ projectId: consulting.id, source: "sorter", score: null });
    expect(rows["a1:m3"]).toMatchObject({ projectId: null, source: "sorter" });
  });

  it("files nothing under a name it does not recognise", async () => {
    const db = testDb();
    seed(db);
    seedCategories(db);
    seedProjects(db);
    const sorter = new ScriptedSorter(() => ({
      important: false, needs_reply: false, scheduling: false, category: "FYI", project: "Gardening", reason: "x",
    }));

    await sortPending(db, sorter, "criteria");
    expect(db.select().from(projectAssignments).all().every((r) => r.projectId === null)).toBe(true);
  });

  it("never overwrites what the operator filed by hand", async () => {
    const db = testDb();
    seed(db);
    seedCategories(db);
    const { consulting, immigration } = seedProjects(db);
    // The operator moved this thread to Immigration; the sorter disagrees.
    fileThread(db, "a1:t1", immigration.id);
    const sorter = new ScriptedSorter(() => ({
      important: true, needs_reply: true, scheduling: false, category: "Needs reply", project: "Consulting", reason: "x",
    }));

    await sortPending(db, sorter, "criteria");
    const row = db.select().from(projectAssignments).all().find((r) => r.messageId === "a1:m1")!;
    expect(row).toMatchObject({ projectId: immigration.id, source: "manual" });

    // And a later re-sort leaves it alone too.
    await resortWindow(db, sorter, "criteria", { since: 0 });
    expect(db.select().from(projectAssignments).all().find((r) => r.messageId === "a1:m1")).toMatchObject({
      projectId: immigration.id,
      source: "manual",
    });
    expect(consulting.id).not.toBe(immigration.id);
  });

  it("re-files on a re-sort, which is what Re-file this inbox asks for", async () => {
    const db = testDb();
    seed(db);
    seedCategories(db);
    const { consulting, immigration } = seedProjects(db);
    const first = new ScriptedSorter(() => ({
      important: true, needs_reply: false, scheduling: false, category: "FYI", project: "Consulting", reason: "x",
    }));
    await sortPending(db, first, "criteria");
    expect(db.select().from(projectAssignments).all().every((r) => r.projectId === consulting.id)).toBe(true);

    const second = new ScriptedSorter(() => ({
      important: true, needs_reply: false, scheduling: false, category: "FYI", project: "Immigration", reason: "y",
    }));
    await resortWindow(db, second, "criteria", { since: 0 });
    expect(db.select().from(projectAssignments).all().every((r) => r.projectId === immigration.id)).toBe(true);
  });
});

describe("resortNeedsReply", () => {
  // The seed puts every message in one thread, so its newest inbound message
  // is the only thing "Need to reply" ever shows for it: m3, "Weekly".
  async function waiting(db: ReturnType<typeof testDb>) {
    seed(db);
    seedCategories(db);
    await sortPending(
      db,
      new ScriptedSorter(() => ({ important: true, needs_reply: true, scheduling: false, category: "Needs reply", reason: "asks" })),
      "criteria",
    );
  }

  it("lets the sorter clear mail that never needed an answer", async () => {
    const db = testDb();
    await waiting(db);

    // The new rule: a newsletter is not a person waiting for an answer.
    const stricter = new ScriptedSorter(() => ({
      important: true, needs_reply: false, scheduling: false, category: "FYI", reason: "a notice, not a question",
    }));
    expect(await resortNeedsReply(db, stricter, "criteria")).toEqual({ resorted: 1, cleared: 1 });

    const byId = Object.fromEntries(db.select().from(sorts).all().map((s) => [s.messageId, s]));
    expect(byId["a1:m3"]).toMatchObject({ needsReply: false, category: "FYI", reason: "a notice, not a question" });
    // m1 is an older message of the same thread, so it is not on the list and
    // is not paid for.
    expect(byId["a1:m1"]).toMatchObject({ needsReply: true, reason: "asks" });
    expect(stricter.calls.map((c) => c.subject)).toEqual(["Weekly"]);
  });

  it("never touches importance, which is the operator's standing default", async () => {
    const db = testDb();
    await waiting(db);
    const quiet = new ScriptedSorter(() => ({ important: false, needs_reply: false, scheduling: false, category: "FYI", reason: "noise" }));
    await resortNeedsReply(db, quiet, "criteria");
    expect(db.select().from(sorts).all().every((s) => s.important)).toBe(true);
  });

  it("stops reading a thread once something newer arrives in it", async () => {
    const db = testDb();
    await waiting(db);
    db.insert(messages)
      .values({
        id: "a1:m9", accountId: "a1", providerMessageId: "m9", threadId: "a1:t1", rfcMessageId: null, fromAddress: "bob@example.com",
        fromName: null, toAddresses: ["me@example.com"], ccAddresses: [], subject: "Later", bodyText: "Never mind.", bodyHtml: null,
        snippet: null, attachmentNames: [], isFromOperator: false, sentAt: 400, receivedAt: 1,
      })
      .run();

    const sorter = new ScriptedSorter(() => ({ important: true, needs_reply: true, scheduling: false, category: "FYI", reason: "x" }));
    // The thread's last word is now unsorted, so nothing on the list is waiting.
    expect(await resortNeedsReply(db, sorter, "criteria")).toEqual({ resorted: 0, cleared: 0 });
    expect(sorter.calls).toEqual([]);
  });

  it("narrows to one inbox, and a failure costs one message rather than the run", async () => {
    const db = testDb();
    await waiting(db);
    const other = new ScriptedSorter(() => ({ important: true, needs_reply: true, scheduling: false, category: "FYI", reason: "x" }));
    expect(await resortNeedsReply(db, other, "criteria", { accountId: "a2" })).toEqual({ resorted: 0, cleared: 0 });

    const flaky = new ScriptedSorter(() => new Error("model down"));
    expect(await resortNeedsReply(db, flaky, "criteria")).toEqual({ resorted: 0, cleared: 0 });
    // The verdict it could not re-read is left as it was.
    expect(db.select().from(sorts).all().find((s) => s.messageId === "a1:m3")).toMatchObject({ needsReply: true });
  });
});
