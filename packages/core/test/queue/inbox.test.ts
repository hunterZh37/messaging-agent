import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../helpers/db";
import { accounts, attachments, drafts, messages, sorts, threads } from "../../src/db/schema";
import { recordAction } from "../../src/queue/actions";
import { countByCategory, countImportantUnhandled, folderCounts, listInboxMessages, getThread } from "../../src/queue/inbox";
import { createProject } from "../../src/projects/projects";
import { ALL_KEY, countByProject, fileThread, UNFILED_KEY } from "../../src/projects/classify";
import { seedMail } from "../chat/seed";

function seed(db: ReturnType<typeof testDb>) {
  db.insert(accounts)
    .values([
      { id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: 1 },
      { id: "a2", provider: "imap", email: "work@example.com", displayName: null, createdAt: 1 },
    ])
    .run();
  db.insert(threads)
    .values([
      { id: "a1:t1", accountId: "a1", providerThreadId: "t1", subject: "Lunch", lastMessageAt: 300, lastFromOperator: false },
      { id: "a1:t2", accountId: "a1", providerThreadId: "t2", subject: "Invoice", lastMessageAt: 200, lastFromOperator: false },
      { id: "a2:t3", accountId: "a2", providerThreadId: "t3", subject: "Standup", lastMessageAt: 100, lastFromOperator: false },
    ])
    .run();
  const base = { fromName: null, ccAddresses: [], snippet: null, attachmentNames: [], receivedAt: 1 };
  db.insert(messages)
    .values([
      // a1:t1 - operator sent first, then bob replied (important)
      { ...base, id: "a1:t1:m1", accountId: "a1", providerMessageId: "m1", threadId: "a1:t1", rfcMessageId: "<m1@x>", fromAddress: "me@example.com", toAddresses: ["bob@x.com"], subject: "Lunch", bodyText: "When works?", isFromOperator: true, sentAt: 100 },
      { ...base, id: "a1:t1:m2", accountId: "a1", providerMessageId: "m2", threadId: "a1:t1", rfcMessageId: "<m2@x>", fromAddress: "bob@x.com", toAddresses: ["me@example.com"], subject: "Lunch", bodyText: "Friday works for me, noon?", isFromOperator: false, sentAt: 300 },
      // a1:t2 - not important, single inbound message
      { ...base, id: "a1:t2:m1", accountId: "a1", providerMessageId: "m3", threadId: "a1:t2", rfcMessageId: "<m3@x>", fromAddress: "billing@vendor.com", toAddresses: ["me@example.com"], subject: "Invoice", bodyText: "Your invoice is ready.", isFromOperator: false, sentAt: 200 },
      // a2:t3 - different account, important
      { ...base, id: "a2:t3:m1", accountId: "a2", providerMessageId: "m4", threadId: "a2:t3", rfcMessageId: "<m4@x>", fromAddress: "carol@work.com", toAddresses: ["work@example.com"], subject: "Standup", bodyText: "Can you lead standup tomorrow?", isFromOperator: false, sentAt: 100 },
    ])
    .run();
  db.insert(sorts)
    .values([
      { messageId: "a1:t1:m2", wants: "reply", scheduling: true, category: "Scheduling", reason: "asks to confirm Friday", model: "x", labeledAt: null, createdAt: 1 },
      { messageId: "a1:t2:m1", wants: "bin", scheduling: false, category: null, reason: "routine invoice", model: "x", labeledAt: null, createdAt: 1 },
      { messageId: "a2:t3:m1", wants: "reply", scheduling: false, category: "Needs reply", reason: "asks to lead standup", model: "x", labeledAt: null, createdAt: 1 },
    ])
    .run();
}

describe("listInboxMessages", () => {
  it("lists inbound messages newest first, excluding operator messages", () => {
    const db = testDb();
    seed(db);
    const rows = listInboxMessages(db);
    expect(rows.map((r) => r.message.id)).toEqual(["a1:t1:m2", "a1:t2:m1", "a2:t3:m1"]);
    expect(rows.every((r) => !r.message.isFromOperator)).toBe(true);
    expect(rows[0]?.account.email).toBe("me@example.com");
    expect(rows[0]?.thread.id).toBe("a1:t1");
    expect(rows[0]?.sort?.reason).toBe("asks to confirm Friday");
    expect(rows[0]?.handled).toBe(false);
  });

  it("filters to the rows worth surfacing when important is asked for", () => {
    const db = testDb();
    seed(db);
    const rows = listInboxMessages(db, { important: true });
    expect(rows.map((r) => r.message.id)).toEqual(["a1:t1:m2", "a2:t3:m1"]);
  });

  it("filters to one sub-category, including the reserved Other", () => {
    const db = testDb();
    seed(db);
    expect(listInboxMessages(db, { important: true, category: "Scheduling" }).map((r) => r.message.id)).toEqual(["a1:t1:m2"]);
    expect(listInboxMessages(db, { important: true, category: "Needs reply" }).map((r) => r.message.id)).toEqual(["a2:t3:m1"]);
    expect(listInboxMessages(db, { important: true, category: "Other" })).toEqual([]);
    db.update(sorts).set({ category: "Other" }).where(eq(sorts.messageId, "a2:t3:m1")).run();
    expect(listInboxMessages(db, { important: true, category: "Other" }).map((r) => r.message.id)).toEqual(["a2:t3:m1"]);
  });

  it("filters by account", () => {
    const db = testDb();
    seed(db);
    const rows = listInboxMessages(db, { accountId: "a2" });
    expect(rows.map((r) => r.message.id)).toEqual(["a2:t3:m1"]);
  });

  it("paginates with before, by sentAt", () => {
    const db = testDb();
    seed(db);
    const rows = listInboxMessages(db, { before: 300 });
    expect(rows.map((r) => r.message.id)).toEqual(["a1:t2:m1", "a2:t3:m1"]);
  });

  it("respects a custom limit", () => {
    const db = testDb();
    seed(db);
    const rows = listInboxMessages(db, { limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message.id).toBe("a1:t1:m2");
  });

  it("marks a row handled once a handled action exists for its message, and hides it from the important filter", () => {
    const db = testDb();
    seed(db);
    recordAction(db, { kind: "handled", messageId: "a1:t1:m2", payload: {} });
    const all = listInboxMessages(db);
    expect(all.find((r) => r.message.id === "a1:t1:m2")?.handled).toBe(true);
    const important = listInboxMessages(db, { important: true });
    expect(important.map((r) => r.message.id)).toEqual(["a2:t3:m1"]);
  });
});

describe("countByCategory", () => {
  it("counts important, unhandled, non-operator messages per category", () => {
    const db = testDb();
    seed(db);
    expect(countByCategory(db)).toEqual({ Scheduling: 1, "Needs reply": 1 });
  });

  it("drops handled messages and scopes to one account", () => {
    const db = testDb();
    seed(db);
    expect(countByCategory(db, { accountId: "a2" })).toEqual({ "Needs reply": 1 });
    recordAction(db, { kind: "handled", messageId: "a2:t3:m1", payload: {} });
    expect(countByCategory(db)).toEqual({ Scheduling: 1 });
  });

  it("is empty when nothing important is sorted", () => {
    const db = testDb();
    expect(countByCategory(db)).toEqual({});
  });
});

describe("getThread", () => {
  it("returns messages oldest first, the account, the latest inbound sort, and null draft when none pending", () => {
    const db = testDb();
    seed(db);
    const view = getThread(db, "a1:t1");
    expect(view).not.toBeNull();
    expect(view?.thread.id).toBe("a1:t1");
    expect(view?.account.email).toBe("me@example.com");
    expect(view?.messages.map((m) => m.id)).toEqual(["a1:t1:m1", "a1:t1:m2"]);
    expect(view?.sort?.reason).toBe("asks to confirm Friday");
    expect(view?.draft).toBeNull();
  });

  it("returns the pending draft for the thread when one exists", () => {
    const db = testDb();
    seed(db);
    db.insert(drafts)
      .values({ id: "d1", threadId: "a1:t1", replyToMessageId: "a1:t1:m2", originalText: "Noon works.", finalText: null, toAddresses: ["bob@x.com"], ccAddresses: [], status: "pending", model: "x", sentProviderMessageId: null, error: null, createdAt: 1, updatedAt: 1 })
      .run();
    const view = getThread(db, "a1:t1");
    expect(view?.draft?.id).toBe("d1");
  });

  it("ignores a sent or skipped draft (only pending counts)", () => {
    const db = testDb();
    seed(db);
    db.insert(drafts)
      .values({ id: "d1", threadId: "a1:t1", replyToMessageId: "a1:t1:m2", originalText: "Noon works.", finalText: "Noon works.", toAddresses: ["bob@x.com"], ccAddresses: [], status: "sent", model: "x", sentProviderMessageId: "<s1@x>", error: null, createdAt: 1, updatedAt: 1 })
      .run();
    const view = getThread(db, "a1:t1");
    expect(view?.draft).toBeNull();
  });

  it("returns null for an unknown thread", () => {
    const db = testDb();
    seed(db);
    expect(getThread(db, "nope")).toBeNull();
  });
});

describe("getThread attachments", () => {
  it("groups attachment rows by message id, ordered by index", () => {
    const db = testDb();
    seed(db);
    db.insert(attachments)
      .values([
        { id: "a1:t1:m2:1", messageId: "a1:t1:m2", index: 1, filename: "b.png", mimeType: "image/png", size: 20, providerAttachmentId: null, sha256: null, path: null, fetchedAt: null },
        { id: "a1:t1:m2:0", messageId: "a1:t1:m2", index: 0, filename: "a.pdf", mimeType: "application/pdf", size: 10, providerAttachmentId: null, sha256: "abc", path: "/blobs/abc", fetchedAt: 5 },
      ])
      .run();

    const view = getThread(db, "a1:t1")!;
    expect(Object.keys(view.attachments)).toEqual(["a1:t1:m2"]);
    expect(view.attachments["a1:t1:m2"]!.map((a) => a.filename)).toEqual(["a.pdf", "b.png"]);
    expect(view.attachments["a1:t1:m2"]![0]).toMatchObject({ mimeType: "application/pdf", size: 10, path: "/blobs/abc" });
  });

  it("is an empty map for a thread whose messages have no attachments", () => {
    const db = testDb();
    seed(db);
    expect(getThread(db, "a1:t2")!.attachments).toEqual({});
  });
});

describe("the inbox time window", () => {
  it("hides mail sent before `since`, in the list and in the category counts", () => {
    const db = testDb();
    seed(db);

    expect(listInboxMessages(db, { since: 250 }).map((r) => r.message.id)).toEqual(["a1:t1:m2"]);
    expect(listInboxMessages(db, { since: 0 })).toHaveLength(3);
    expect(countByCategory(db, { since: 250 })).toEqual({ Scheduling: 1 });
    expect(countByCategory(db, { since: 0 })).toEqual({ Scheduling: 1, "Needs reply": 1 });
  });

  it("shows unsorted backfilled mail under All and never under Important", () => {
    const db = testDb();
    seed(db);
    db.insert(messages).values({
      id: "a1:t2:old", accountId: "a1", providerMessageId: "old", threadId: "a1:t2", rfcMessageId: "<old@x>",
      fromAddress: "archive@vendor.com", fromName: null, toAddresses: ["me@example.com"], ccAddresses: [],
      subject: "Older", bodyText: "backfilled", bodyHtml: null, snippet: null, attachmentNames: [],
      isFromOperator: false, sentAt: 50, receivedAt: 1,
    }).run();

    const all = listInboxMessages(db, { since: 0 });
    expect(all.map((r) => r.message.id)).toContain("a1:t2:old");
    expect(all.find((r) => r.message.id === "a1:t2:old")?.sort).toBeNull();
    expect(listInboxMessages(db, { important: true, since: 0 }).map((r) => r.message.id)).not.toContain("a1:t2:old");
  });
});

describe("countImportantUnhandled", () => {
  it("counts important, unhandled, inbound messages for one account", () => {
    const db = testDb();
    seed(db);
    expect(countImportantUnhandled(db, { accountId: "a1" })).toBe(1);
    expect(countImportantUnhandled(db, { accountId: "a2" })).toBe(1);
    expect(countImportantUnhandled(db, {})).toBe(2);
  });

  it("drops handled messages and mail older than `since`", () => {
    const db = testDb();
    seed(db);
    expect(countImportantUnhandled(db, { accountId: "a1", since: 250 })).toBe(1);
    expect(countImportantUnhandled(db, { accountId: "a2", since: 250 })).toBe(0);
    recordAction(db, { kind: "handled", messageId: "a1:t1:m2", payload: {} });
    expect(countImportantUnhandled(db, { accountId: "a1" })).toBe(0);
    expect(countImportantUnhandled(db, {})).toBe(1);
  });
});

describe("projects on the inbox surfaces", () => {
  function withProject(db: ReturnType<typeof testDb>) {
    seed(db);
    const project = createProject(db, "a1", "Consulting", "client work");
    fileThread(db, "a1:t1", project.id);
    return project;
  }

  it("carries the project on every row, null when unfiled", () => {
    const db = testDb();
    const project = withProject(db);
    const rows = listInboxMessages(db);
    expect(rows.find((r) => r.message.id === "a1:t1:m2")?.project?.name).toBe("Consulting");
    expect(rows.find((r) => r.message.id === "a1:t2:m1")?.project).toBeNull();
    expect(rows).toHaveLength(3);
  });

  it("narrows to one project, and to unfiled", () => {
    const db = testDb();
    const project = withProject(db);
    expect(listInboxMessages(db, { projectId: project.id }).map((r) => r.message.id)).toEqual(["a1:t1:m2"]);
    expect(listInboxMessages(db, { projectId: "unfiled" }).map((r) => r.message.id)).toEqual(["a1:t2:m1", "a2:t3:m1"]);
  });

  it("counts a message the pass explicitly left unfiled as unfiled", () => {
    const db = testDb();
    const project = withProject(db);
    fileThread(db, "a1:t2", null);
    expect(listInboxMessages(db, { projectId: "unfiled" }).map((r) => r.message.id)).toEqual(["a1:t2:m1", "a2:t3:m1"]);
    expect(listInboxMessages(db, { projectId: project.id })).toHaveLength(1);
  });

  it("gives the thread view its project and its inbox's project list", () => {
    const db = testDb();
    const project = withProject(db);
    createProject(db, "a1", "Immigration", "visa");
    const view = getThread(db, "a1:t1")!;
    expect(view.project?.id).toBe(project.id);
    expect(view.projects.map((p) => p.name)).toEqual(["Consulting", "Immigration"]);

    const unfiled = getThread(db, "a1:t2")!;
    expect(unfiled.project).toBeNull();
    expect(unfiled.projects.map((p) => p.name)).toEqual(["Consulting", "Immigration"]);
    // Another inbox sees only its own list.
    expect(getThread(db, "a2:t3")!.projects).toEqual([]);
  });
});

describe("the project bar under All inboxes", () => {
  // Operator, 2026-09-10: under All inboxes each mailbox's projects show on a
  // row of their own. A row's tab count still has to be the length of the
  // list that tab opens, which is what these hold to.
  function twoInboxes(db: ReturnType<typeof testDb>) {
    seed(db);
    const consulting = createProject(db, "a1", "Consulting", "client work");
    const standups = createProject(db, "a2", "Standups", "the daily");
    fileThread(db, "a1:t1", consulting.id);
    fileThread(db, "a2:t3", standups.id);
    return { consulting, standups };
  }

  it("lists only the owning inbox's mail when a project from another inbox is picked", () => {
    const db = testDb();
    const { standups } = twoInboxes(db);
    // No accountId: the switcher is still on All, and the project narrows it.
    const rows = listInboxMessages(db, { projectId: standups.id });
    expect(rows.map((r) => r.message.id)).toEqual(["a2:t3:m1"]);
    expect(rows.every((r) => r.account.email === "work@example.com")).toBe(true);
  });

  it("gives each row a count equal to the list its tab opens", () => {
    const db = testDb();
    const { consulting, standups } = twoInboxes(db);
    for (const [accountId, project] of [
      ["a1", consulting],
      ["a2", standups],
    ] as const) {
      const counts = countByProject(db, { accountId });
      expect(counts[project.id]).toBe(listInboxMessages(db, { projectId: project.id }).length);
      // Each row's Unfiled is that inbox's, so it is counted and listed over
      // that inbox alone: shared, the two rows would show numbers neither list has.
      expect(counts[UNFILED_KEY] ?? 0).toBe(listInboxMessages(db, { accountId, projectId: UNFILED_KEY }).length);
    }
    expect(countByProject(db, { accountId: "a1" })[UNFILED_KEY]).toBe(1);
    expect(countByProject(db, { accountId: "a2" })[UNFILED_KEY]).toBeUndefined();
  });

  it("counts the leading All tab over every inbox at once, which is the list it opens", () => {
    const db = testDb();
    twoInboxes(db);
    expect(countByProject(db)[ALL_KEY]).toBe(listInboxMessages(db).length);
  });

  it("keeps the folder tree counting the same mail a picked project lists", () => {
    const db = testDb();
    const { standups } = twoInboxes(db);
    // The tree follows the choice to the inbox that owns it, or it would count
    // every inbox's needs-reply while the list showed one inbox's project.
    const scope = { accountId: "a2", projectId: standups.id };
    const tree = folderCounts(db, scope);
    expect(tree.needsReply).toBe(listInboxMessages(db, { ...scope, status: "needs_reply" }).length);
    expect(tree.needsReply).toBe(1);
    expect(folderCounts(db, { accountId: "a1", projectId: standups.id }).needsReply).toBe(0);
  });
});

describe("No reply needed", () => {
  it("takes a thread out of Waiting and puts it back", async () => {
    const { isWaitingReply, setThreadWaiting } = await import("../../src/queue/inbox");
    const { threads: threadsTable } = await import("../../src/db/schema");
    const db = testDb();
    seedMail(db, [{ id: "m1", threadId: "a1:t1", subject: "Any update?", bodyText: "Could you send the signed copy?", isFromOperator: true, sentAt: 10 }]);
    const row = () => {
      const thread = db.select().from(threadsTable).where(eq(threadsTable.id, "a1:t1")).get()!;
      return { message: { sentAt: 10, bodyText: "Could you send the signed copy?" }, thread };
    };
    expect(isWaitingReply(row())).toBe(true);
    setThreadWaiting(db, "a1:t1", false, () => 99);
    expect(row().thread.waitingDismissedAt).toBe(99);
    expect(isWaitingReply(row())).toBe(false);
    setThreadWaiting(db, "a1:t1", true);
    expect(isWaitingReply(row())).toBe(true);
  });
});
