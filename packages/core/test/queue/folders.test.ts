import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../helpers/db";
import { accounts, drafts, messages, sorts, threads } from "../../src/db/schema";
import { recordAction } from "../../src/queue/actions";
import {
  countByFinance,
  disposableThreadIds,
  folderCounts,
  hiddenThreadIds,
  listInboxMessages,
  markMessagesReadElsewhere,
  markThreadOpened,
  markThreadOpenedUpTo,
  markThreadsOpened,
  restoreThreadOpens,
  threadOpensOf,
  unopenedThreadIds,
} from "../../src/queue/inbox";
import { ALL_KEY, countByProject, fileThread, UNFILED_KEY } from "../../src/projects/classify";
import { createProject } from "../../src/projects/projects";

const base = { fromName: null, ccAddresses: [], snippet: null, attachmentNames: [], receivedAt: 1, bodyHtml: null };

/**
 * One inbox holding: a thread waiting on the operator, a thread the operator
 * answered with a question, a thread the operator closed off, and one message
 * each in Deleted items and Junk.
 */
function seed(db: ReturnType<typeof testDb>) {
  db.insert(accounts).values({ id: "a1", provider: "imap", email: "me@example.com", displayName: null, createdAt: 1 }).run();
  db.insert(threads)
    .values([
      { id: "a1:t1", accountId: "a1", providerThreadId: "t1", subject: "Lunch", lastMessageAt: 300, lastFromOperator: false },
      { id: "a1:t2", accountId: "a1", providerThreadId: "t2", subject: "Deck", lastMessageAt: 400, lastFromOperator: true },
      { id: "a1:t3", accountId: "a1", providerThreadId: "t3", subject: "Invoice", lastMessageAt: 500, lastFromOperator: true },
      { id: "a1:t4", accountId: "a1", providerThreadId: "t4", subject: "Offer", lastMessageAt: 600, lastFromOperator: false },
      { id: "a1:t5", accountId: "a1", providerThreadId: "t5", subject: "Prize", lastMessageAt: 700, lastFromOperator: false },
    ])
    .run();
  db.insert(messages)
    .values([
      // Inbox: needs a reply and the operator has not answered.
      { ...base, id: "a1:m1", accountId: "a1", providerMessageId: "INBOX:1", threadId: "a1:t1", rfcMessageId: null, fromAddress: "bob@x.com", toAddresses: ["me@example.com"], subject: "Lunch", bodyText: "Friday?", isFromOperator: false, folder: "inbox", sentAt: 300 },
      // Inbox: sorted as needing a reply, but the operator already replied (t2 ends with them).
      { ...base, id: "a1:m2", accountId: "a1", providerMessageId: "INBOX:2", threadId: "a1:t2", rfcMessageId: null, fromAddress: "carol@x.com", toAddresses: ["me@example.com"], subject: "Deck", bodyText: "Here is the deck.", isFromOperator: false, folder: "inbox", sentAt: 350 },
      // Inbox: no verdict at all.
      { ...base, id: "a1:m3", accountId: "a1", providerMessageId: "INBOX:3", threadId: "a1:t4", rfcMessageId: null, fromAddress: "dave@x.com", toAddresses: ["me@example.com"], subject: "Offer", bodyText: "Special offer.", isFromOperator: false, folder: "inbox", sentAt: 600 },
      // Sent: ends its thread and asks something.
      { ...base, id: "a1:s1", accountId: "a1", providerMessageId: "[Gmail]/Sent Mail:1", threadId: "a1:t2", rfcMessageId: null, fromAddress: "me@example.com", toAddresses: ["carol@x.com"], subject: "Deck", bodyText: "Could you send the final numbers?\n\nOn Mon, Carol wrote:\n> here is the deck", isFromOperator: true, folder: "sent", sentAt: 400 },
      // Sent: ends its thread but asks nothing.
      { ...base, id: "a1:s2", accountId: "a1", providerMessageId: "[Gmail]/Sent Mail:2", threadId: "a1:t3", rfcMessageId: null, fromAddress: "me@example.com", toAddresses: ["billing@x.com"], subject: "Invoice", bodyText: "Paid, thanks.", isFromOperator: true, folder: "sent", sentAt: 500 },
      // Sent: asks something, but the other side has answered since.
      { ...base, id: "a1:s3", accountId: "a1", providerMessageId: "[Gmail]/Sent Mail:3", threadId: "a1:t1", rfcMessageId: null, fromAddress: "me@example.com", toAddresses: ["bob@x.com"], subject: "Lunch", bodyText: "Can you do Friday?", isFromOperator: true, folder: "sent", sentAt: 100 },
      // Deleted items and Junk, one each.
      { ...base, id: "a1:d1", accountId: "a1", providerMessageId: "[Gmail]/Trash:1", threadId: "a1:t4", rfcMessageId: null, fromAddress: "old@x.com", toAddresses: ["me@example.com"], subject: "Old", bodyText: "Old thing.", isFromOperator: false, folder: "trash", sentAt: 610 },
      { ...base, id: "a1:j1", accountId: "a1", providerMessageId: "[Gmail]/Spam:1", threadId: "a1:t5", rfcMessageId: null, fromAddress: "spam@x.com", toAddresses: ["me@example.com"], subject: "Prize", bodyText: "You won!", isFromOperator: false, folder: "junk", sentAt: 700 },
    ])
    .run();
  db.insert(sorts)
    .values([
      { messageId: "a1:m1", wants: "reply", scheduling: false, category: "Scheduling", reason: "asks about Friday", model: "x", labeledAt: null, createdAt: 1 },
      { messageId: "a1:m2", wants: "reply", scheduling: false, category: "Needs reply", reason: "sent the deck", model: "x", labeledAt: null, createdAt: 1 },
    ])
    .run();
}

const ids = (rows: { message: { id: string } }[]) => rows.map((r) => r.message.id);

describe("listInboxMessages folders", () => {
  it("defaults to the inbox and leaves sent, deleted and junk out of it", () => {
    const db = testDb();
    seed(db);
    expect(ids(listInboxMessages(db))).toEqual(["a1:m3", "a1:m2", "a1:m1"]);
  });

  it("lists the operator's own mail under sent", () => {
    const db = testDb();
    seed(db);
    expect(ids(listInboxMessages(db, { folder: "sent" }))).toEqual(["a1:s2", "a1:s1", "a1:s3"]);
  });

  it("lists deleted items and junk whoever sent them", () => {
    const db = testDb();
    seed(db);
    expect(ids(listInboxMessages(db, { folder: "trash" }))).toEqual(["a1:d1"]);
    expect(ids(listInboxMessages(db, { folder: "junk" }))).toEqual(["a1:j1"]);
  });

  it("narrows the inbox to what needs a reply: sorted needs_reply, unhandled, and the operator has not answered", () => {
    const db = testDb();
    seed(db);
    expect(ids(listInboxMessages(db, { status: "needs_reply" }))).toEqual(["a1:m1"]);
    expect(ids(listInboxMessages(db, { status: "no_reply" }))).toEqual(["a1:m3", "a1:m2"]);
  });

  it("drops a message from needs_reply once it is marked handled", () => {
    const db = testDb();
    seed(db);
    recordAction(db, { kind: "handled", messageId: "a1:m1", payload: {} });
    expect(ids(listInboxMessages(db, { status: "needs_reply" }))).toEqual([]);
    expect(ids(listInboxMessages(db, { status: "no_reply" }))).toEqual(["a1:m3", "a1:m2", "a1:m1"]);
  });

  it("narrows sent to what is waiting: still ends the thread and asks something once quoted text is gone", () => {
    const db = testDb();
    seed(db);
    expect(ids(listInboxMessages(db, { folder: "sent", status: "waiting" }))).toEqual(["a1:s1"]);
    expect(ids(listInboxMessages(db, { folder: "sent", status: "not_waiting" }))).toEqual(["a1:s2", "a1:s3"]);
  });

  it("honours the window and the account on every folder", () => {
    const db = testDb();
    seed(db);
    expect(ids(listInboxMessages(db, { folder: "junk", since: 800 }))).toEqual([]);
    expect(ids(listInboxMessages(db, { folder: "junk", accountId: "a2" }))).toEqual([]);
  });

  it("filters by project in every folder, and alongside a status", () => {
    const db = testDb();
    seed(db);
    // The Deck thread is filed under a project; everything else stays Unfiled.
    const project = createProject(db, "a1", "Consulting", "client work");
    fileThread(db, "a1:t2", project.id);

    expect(ids(listInboxMessages(db, { projectId: project.id }))).toEqual(["a1:m2"]);
    expect(ids(listInboxMessages(db, { folder: "sent", projectId: project.id }))).toEqual(["a1:s1"]);
    expect(ids(listInboxMessages(db, { folder: "sent", projectId: "unfiled" }))).toEqual(["a1:s2", "a1:s3"]);
    expect(ids(listInboxMessages(db, { folder: "trash", projectId: "unfiled" }))).toEqual(["a1:d1"]);
    expect(ids(listInboxMessages(db, { folder: "trash", projectId: project.id }))).toEqual([]);
    // A project narrows a tree child row rather than replacing it.
    expect(ids(listInboxMessages(db, { status: "no_reply", projectId: "unfiled" }))).toEqual(["a1:m3"]);
    expect(ids(listInboxMessages(db, { status: "no_reply", projectId: project.id }))).toEqual(["a1:m2"]);
    expect(ids(listInboxMessages(db, { folder: "sent", status: "waiting", projectId: project.id }))).toEqual(["a1:s1"]);
    expect(ids(listInboxMessages(db, { folder: "sent", status: "waiting", projectId: "unfiled" }))).toEqual([]);
  });
});

describe("the finance axis", () => {
  // m1 is important and a bill; m3 is not important and a payout, which is the
  // point: money is judged whether or not the message was worth surfacing.
  function money(db: ReturnType<typeof testDb>) {
    db.update(sorts).set({ finance: "expense" }).where(eq(sorts.messageId, "a1:m1")).run();
    db.insert(sorts)
      .values({ messageId: "a1:m3", wants: "bin", scheduling: false, category: null, finance: "income", reason: "a payout", model: "x", labeledAt: null, createdAt: 1 })
      .run();
  }

  it("narrows the whole inbox, not only its important half", () => {
    const db = testDb();
    seed(db);
    money(db);
    expect(ids(listInboxMessages(db, { finance: "expense" }))).toEqual(["a1:m1"]);
    expect(ids(listInboxMessages(db, { finance: "income" }))).toEqual(["a1:m3"]);
    // m2 is sorted but its finance is "none", so neither side claims it, and
    // the window still applies on top.
    expect(ids(listInboxMessages(db, { finance: "expense", since: 400 }))).toEqual([]);
    expect(ids(listInboxMessages(db, { finance: "income", since: 601 }))).toEqual([]);
  });

  it("counts each way over the same population the list shows", () => {
    const db = testDb();
    seed(db);
    money(db);
    expect(countByFinance(db, { accountId: "a1" })).toEqual({ income: 1, expense: 1 });
    expect(countByFinance(db, { accountId: "a1", since: 400 })).toEqual({ income: 1, expense: 0 });
    expect(countByFinance(db, { accountId: "a1", since: 601 })).toEqual({ income: 0, expense: 0 });
    expect(countByFinance(db, { accountId: "a2" })).toEqual({ income: 0, expense: 0 });
    // Sent, Deleted items and Junk have no verdicts, so they are not counted here.
    expect(countByFinance(db)).toEqual({ income: 1, expense: 1 });
  });
});

describe("folderCounts", () => {
  it("counts pending drafts, mail needing a reply, and sent mail waiting on an answer", () => {
    const db = testDb();
    seed(db);
    db.insert(drafts)
      .values({
        id: "d1",
        threadId: "a1:t1",
        replyToMessageId: "a1:m1",
        originalText: "Friday works.",
        finalText: null,
        toAddresses: ["bob@x.com"],
        ccAddresses: [],
        status: "pending",
        model: "x",
        sentProviderMessageId: null,
        error: null,
        createdAt: 1,
        updatedAt: 1,
      })
      .run();

    expect(folderCounts(db, { since: 0 })).toEqual({ inbox: 3, drafts: 1, needsReply: 1, unopened: expect.any(Number), disposable: 0, waiting: 1, hidden: 0, texts: { needsReply: 0, unopened: 0, disposable: 0, hidden: 0 } });
    expect(folderCounts(db, { accountId: "a1", since: 0 })).toEqual({ inbox: 3, drafts: 1, needsReply: 1, unopened: expect.any(Number), disposable: 0, waiting: 1, hidden: 0, texts: { needsReply: 0, unopened: 0, disposable: 0, hidden: 0 } });
  });

  it("counts nothing outside the window, and nothing for another inbox", () => {
    const db = testDb();
    seed(db);
    expect(folderCounts(db, { since: 1_000 })).toEqual({ inbox: 0, drafts: 0, needsReply: 0, unopened: expect.any(Number), disposable: 0, waiting: 0, hidden: 0, texts: { needsReply: 0, unopened: 0, disposable: 0, hidden: 0 } });
    expect(folderCounts(db, { accountId: "a2", since: 0 })).toEqual({ inbox: 0, drafts: 0, needsReply: 0, unopened: expect.any(Number), disposable: 0, waiting: 0, hidden: 0, texts: { needsReply: 0, unopened: 0, disposable: 0, hidden: 0 } });
  });
});

describe("the header's counts describe the list beneath them", () => {
  // The bug this covers: a project tab said 7 while the list under
  // "Need to reply" showed 1, because the counts ignored the tree's child row.
  const STATUSES = [undefined, "needs_reply", "no_reply"] as const;
  const SENT_STATUSES = [undefined, "waiting", "not_waiting"] as const;

  function seedWithProjects(db: ReturnType<typeof testDb>) {
    seed(db);
    const project = createProject(db, "a1", "Robotics research", "papers and labs");
    // t1 is the thread that needs a reply; t2 and t3 are answered or closed.
    fileThread(db, "a1:t1", project.id);
    fileThread(db, "a1:t2", project.id);
    db.update(sorts).set({ finance: "expense" }).where(eq(sorts.messageId, "a1:m1")).run();
    db.update(sorts).set({ finance: "income" }).where(eq(sorts.messageId, "a1:m2")).run();
    return project;
  }

  it("counts every project the same way the inbox list counts itself", () => {
    const db = testDb();
    const project = seedWithProjects(db);

    for (const status of STATUSES) {
      const scope = { accountId: "a1", ...(status ? { status } : {}) } as const;
      const counts = countByProject(db, scope);
      for (const [key, projectId] of [[ALL_KEY, undefined], [project.id, project.id], [UNFILED_KEY, UNFILED_KEY]] as const) {
        const rows = listInboxMessages(db, { ...scope, ...(projectId ? { projectId } : {}) });
        expect({ status, key, n: counts[key] ?? 0 }).toEqual({ status, key, n: rows.length });
      }
    }
  });

  it("counts money the same way the inbox list counts itself", () => {
    const db = testDb();
    seedWithProjects(db);

    for (const status of STATUSES) {
      const scope = { accountId: "a1", ...(status ? { status } : {}) } as const;
      const counts = countByFinance(db, scope);
      for (const side of ["income", "expense"] as const) {
        const rows = listInboxMessages(db, { ...scope, finance: side });
        expect({ status, side, n: counts[side] }).toEqual({ status, side, n: rows.length });
      }
    }
  });

  it("counts a project over what is above it, and money over everything", () => {
    const db = testDb();
    const project = seedWithProjects(db);
    db.update(sorts).set({ finance: "expense" }).where(eq(sorts.messageId, "a1:m2")).run();

    // The header's order (spec 10a): a project tab is counted over the folder,
    // the tree's child row and the inbox, so a money side cannot move it.
    const above = { accountId: "a1" } as const;
    const projectCounts = countByProject(db, above);
    for (const [key, projectId] of [[ALL_KEY, undefined], [project.id, project.id], [UNFILED_KEY, UNFILED_KEY]] as const) {
      const rows = listInboxMessages(db, { ...above, ...(projectId ? { projectId } : {}) });
      expect({ key, n: projectCounts[key] ?? 0 }).toEqual({ key, n: rows.length });
    }
    // Same numbers whichever side of the money axis is on: that is the rule.
    expect(countByProject(db, { ...above, finance: "expense" })).not.toEqual(projectCounts);
    expect(projectCounts).toEqual(countByProject(db, above));

    // Money sits below the project, so the project that is on narrows it and
    // each side's number is what clicking it would show.
    const withProject = { accountId: "a1", projectId: project.id } as const;
    const financeCounts = countByFinance(db, withProject);
    for (const side of ["income", "expense"] as const) {
      const rows = listInboxMessages(db, { ...withProject, finance: side });
      expect({ side, n: financeCounts[side] }).toEqual({ side, n: rows.length });
    }
  });

  it("agrees on Sent too, where Waiting is decided by reading the message", () => {
    const db = testDb();
    const project = seedWithProjects(db);

    for (const status of SENT_STATUSES) {
      const scope = { accountId: "a1", folder: "sent", ...(status ? { status } : {}) } as const;
      const counts = countByProject(db, scope);
      for (const [key, projectId] of [[ALL_KEY, undefined], [project.id, project.id], [UNFILED_KEY, UNFILED_KEY]] as const) {
        const rows = listInboxMessages(db, { ...scope, ...(projectId ? { projectId } : {}) });
        expect({ status, key, n: counts[key] ?? 0 }).toEqual({ status, key, n: rows.length });
      }
    }
  });
});

describe("the tree's counts agree with the lists they open", () => {
  // The bug this covers: the tree said "Need to reply · 4" over a list of one,
  // because the tree counted a fixed 30 days while the view showed 7.
  it("counts the window it is given, and all of it when given none", () => {
    const db = testDb();
    seed(db);

    for (const since of [undefined, 0, 301, 601] as const) {
      const window = since === undefined ? {} : { since };
      const counts = folderCounts(db, window);
      expect({ since, n: counts.needsReply }).toEqual({
        since,
        n: listInboxMessages(db, { folder: "inbox", status: "needs_reply", ...window }).length,
      });
      expect({ since, n: counts.waiting }).toEqual({
        since,
        n: listInboxMessages(db, { folder: "sent", status: "waiting", ...window }).length,
      });
    }
  });

  it("follows the project and the money side the operator has on", () => {
    const db = testDb();
    seed(db);
    // t1 needs a reply and is filed; t3 is the operator's own waiting thread.
    const project = createProject(db, "a1", "Robotics research", "papers and labs");
    fileThread(db, "a1:t1", project.id);
    fileThread(db, "a1:t3", project.id);
    db.update(sorts).set({ finance: "expense" }).where(eq(sorts.messageId, "a1:m1")).run();

    const scopes = [
      { accountId: "a1", projectId: project.id },
      { accountId: "a1", projectId: UNFILED_KEY },
      { accountId: "a1", finance: "expense" },
      { accountId: "a1", projectId: project.id, finance: "expense" },
      { accountId: "a1", projectId: project.id, finance: "income" },
    ] as const;

    for (const scope of scopes) {
      const counts = folderCounts(db, scope);
      expect({ scope, n: counts.needsReply }).toEqual({
        scope,
        n: listInboxMessages(db, { ...scope, folder: "inbox", status: "needs_reply" }).length,
      });
      // Money is a verdict on inbound mail, so Sent ignores it, count and list alike.
      const { finance: _finance, ...sentScope } = scope as { finance?: "income" | "expense"; accountId: string; projectId?: string };
      expect({ scope, n: counts.waiting }).toEqual({
        scope,
        n: listInboxMessages(db, { ...sentScope, folder: "sent", status: "waiting" }).length,
      });
    }
  });

  it("narrows to one inbox the same way the lists do", () => {
    const db = testDb();
    seed(db);
    expect(folderCounts(db, { accountId: "a1" }).needsReply).toBe(
      listInboxMessages(db, { folder: "inbox", status: "needs_reply", accountId: "a1" }).length,
    );
    expect(folderCounts(db, { accountId: "a2" })).toEqual({ inbox: 0, drafts: 0, needsReply: 0, unopened: 0, disposable: 0, waiting: 0, hidden: 0, texts: { needsReply: 0, unopened: 0, disposable: 0, hidden: 0 } });
  });
});

describe("unread", () => {
  const unreadOf = (db: ReturnType<typeof testDb>) =>
    Object.fromEntries(listInboxMessages(db, { accountId: "a1" }).map((r) => [r.message.id, r.unread]));

  it("is true for a thread the operator has never opened", () => {
    const db = testDb();
    seed(db);
    expect(Object.values(unreadOf(db)).every(Boolean)).toBe(true);
  });

  it("goes quiet once the thread is opened after its newest message", () => {
    const db = testDb();
    seed(db);
    // t1's newest message is m1 at 300; opening after that clears it.
    markThreadOpened(db, "a1:t1", 400);
    expect(unreadOf(db)["a1:m1"]).toBe(false);
    // Other threads are untouched.
    expect(unreadOf(db)["a1:m3"]).toBe(true);
  });

  it("comes back when something new arrives after the open", () => {
    const db = testDb();
    seed(db);
    markThreadOpened(db, "a1:t1", 400);
    expect(unreadOf(db)["a1:m1"]).toBe(false);

    db.insert(messages)
      .values({
        ...base, id: "a1:m9", accountId: "a1", providerMessageId: "INBOX:9", threadId: "a1:t1", rfcMessageId: null,
        fromAddress: "bob@x.com", toAddresses: ["me@example.com"], subject: "Lunch", bodyText: "Still on?",
        isFromOperator: false, folder: "inbox", sentAt: 500,
      })
      .run();
    expect(unreadOf(db)["a1:m9"]).toBe(true);
    // The whole thread is unread, so its older rows say so too.
    expect(unreadOf(db)["a1:m1"]).toBe(true);
  });

  it("is not stirred by the operator's own message", () => {
    const db = testDb();
    seed(db);
    markThreadOpened(db, "a1:t1", 400);
    db.insert(messages)
      .values({
        ...base, id: "a1:s9", accountId: "a1", providerMessageId: "SENT:9", threadId: "a1:t1", rfcMessageId: null,
        fromAddress: "me@example.com", toAddresses: ["bob@x.com"], subject: "Lunch", bodyText: "Yes.",
        isFromOperator: true, folder: "sent", sentAt: 500,
      })
      .run();
    // They were there when they sent it.
    expect(unreadOf(db)["a1:m1"]).toBe(false);
  });

  it("moves the time forward when a thread is opened again", () => {
    const db = testDb();
    seed(db);
    markThreadOpened(db, "a1:t1", 100);
    expect(unreadOf(db)["a1:m1"]).toBe(true);
    markThreadOpened(db, "a1:t1", 400);
    expect(unreadOf(db)["a1:m1"]).toBe(false);
  });
});

/**
 * What the provider knows the operator read (2026-09-14). Mail read on the
 * phone or years ago in Gmail arrived here as unopened, and every Mark all
 * only cleared the view on screen, so old read mail kept surfacing.
 */
describe("read elsewhere", () => {
  const unreadOf = (db: ReturnType<typeof testDb>) =>
    Object.fromEntries(listInboxMessages(db, { accountId: "a1" }).map((r) => [r.message.id, r.unread]));

  it("opens the thread up to the message the provider says was read, and no further", () => {
    const db = testDb();
    seed(db);
    markThreadOpenedUpTo(db, "a1:t1", 300);
    expect(unreadOf(db)["a1:m1"]).toBe(false);
    // Something newer than the read message keeps the thread unread.
    db.insert(messages)
      .values({ ...base, id: "a1:m9", accountId: "a1", providerMessageId: "INBOX:9", threadId: "a1:t1", rfcMessageId: null, fromAddress: "bob@x.com", toAddresses: ["me@example.com"], subject: "Lunch", bodyText: "Or Monday?", isFromOperator: false, folder: "inbox", sentAt: 900 })
      .run();
    expect(unreadOf(db)["a1:m9"]).toBe(true);
    // Reading the older one again moves nothing backwards.
    markThreadOpened(db, "a1:t1", 950);
    markThreadOpenedUpTo(db, "a1:t1", 300);
    expect(unreadOf(db)["a1:m9"]).toBe(false);
  });

  it("marks each read message's thread, by our ids, and leaves the operator's own mail out", () => {
    const db = testDb();
    seed(db);
    expect(markMessagesReadElsewhere(db, ["a1:m1", "a1:s2", "a1:none"])).toBe(1);
    expect(threadOpensOf(db, ["a1:t1", "a1:t3"])).toEqual({ "a1:t1": 300 });
    expect(markMessagesReadElsewhere(db, [])).toBe(0);
  });

  it("a reply that went to Junk or Trash does not put an opened thread back in Unopened", () => {
    const db = testDb();
    seed(db);
    markThreadOpened(db, "a1:t4", 605);
    // t4's trash message (a1:d1 at 610) is newer than the open.
    expect(unreadOf(db)["a1:m3"]).toBe(false);
    expect(unopenedThreadIds(db, { accountId: "a1" })).not.toContain("a1:t4");
    // Inbox mail after the open still does.
    db.insert(messages)
      .values({ ...base, id: "a1:m10", accountId: "a1", providerMessageId: "INBOX:10", threadId: "a1:t4", rfcMessageId: null, fromAddress: "dave@x.com", toAddresses: ["me@example.com"], subject: "Offer", bodyText: "Still on?", isFromOperator: false, folder: "inbox", sentAt: 620 })
      .run();
    expect(unopenedThreadIds(db, { accountId: "a1" })).toContain("a1:t4");
  });
});

describe("Need to reply is a fact about the thread", () => {
  // The operator's complaint: 78 rows where 13 threads were actually waiting,
  // because every old question in an exchange counted once more.
  function answered(db: ReturnType<typeof testDb>) {
    seed(db);
    // t1 already holds m1 (needs_reply, at 300). Give it a newer inbound
    // message the sorter cleared: the thread is no longer waiting.
    db.insert(messages)
      .values({
        ...base, id: "a1:m9", accountId: "a1", providerMessageId: "INBOX:9", threadId: "a1:t1", rfcMessageId: null,
        fromAddress: "bob@x.com", toAddresses: ["me@example.com"], subject: "Lunch", bodyText: "Never mind, sorted.",
        isFromOperator: false, folder: "inbox", sentAt: 400,
      })
      .run();
    db.insert(sorts)
      .values({ messageId: "a1:m9", wants: "knowing", scheduling: false, category: "FYI", finance: "none", reason: "closed it", model: "x", labeledAt: null, createdAt: 1 })
      .run();
  }

  it("drops an old question once a newer message in the thread says no", () => {
    const db = testDb();
    answered(db);
    // m1 still says needs_reply, but it is no longer the last word.
    expect(ids(listInboxMessages(db, { status: "needs_reply" }))).toEqual([]);
    expect(ids(listInboxMessages(db, { status: "no_reply" }))).toContain("a1:m1");
  });

  it("drops a thread the operator has answered, wherever the answer sits", () => {
    const db = testDb();
    seed(db);
    // a1:s3 is the operator's own reply in t1, but it is older than m1.
    expect(ids(listInboxMessages(db, { status: "needs_reply" }))).toEqual(["a1:m1"]);

    db.insert(messages)
      .values({
        ...base, id: "a1:s9", accountId: "a1", providerMessageId: "SENT:9", threadId: "a1:t1", rfcMessageId: null,
        fromAddress: "me@example.com", toAddresses: ["bob@x.com"], subject: "Lunch", bodyText: "Friday works.",
        isFromOperator: true, folder: "sent", sentAt: 400,
      })
      .run();
    // The answer lives in Sent, and the thread stops waiting all the same.
    expect(ids(listInboxMessages(db, { status: "needs_reply" }))).toEqual([]);
  });

  it("counts one row per waiting thread, and the two rows split the folder", () => {
    const db = testDb();
    answered(db);
    const all = ids(listInboxMessages(db, {})).length;
    const need = ids(listInboxMessages(db, { status: "needs_reply" }));
    const no = ids(listInboxMessages(db, { status: "no_reply" }));
    expect(need.length + no.length).toBe(all);
    expect(need.filter((id, i) => need.indexOf(id) !== i)).toEqual([]);
  });

  it("is the same number the tree shows", () => {
    const db = testDb();
    answered(db);
    expect(folderCounts(db, {}).needsReply).toBe(listInboxMessages(db, { status: "needs_reply" }).length);
    expect(folderCounts(db, { accountId: "a1" }).needsReply).toBe(0);
  });
});

describe("Unopened", () => {
  const listed = (db: ReturnType<typeof testDb>, scope = {}) => ids(listInboxMessages(db, { ...scope, status: "unopened" }));

  it("holds every inbox thread until it is opened, one row each", () => {
    const db = testDb();
    seed(db);
    // t1 holds m1, t2 m2, t4 m3: three inbox threads, none opened.
    expect(listed(db).sort()).toEqual(["a1:m1", "a1:m2", "a1:m3"]);
  });

  it("drops a thread the moment it is opened, and takes it back when new mail lands", () => {
    const db = testDb();
    seed(db);
    markThreadOpened(db, "a1:t1", 400);
    expect(listed(db)).not.toContain("a1:m1");

    db.insert(messages)
      .values({
        ...base, id: "a1:m9", accountId: "a1", providerMessageId: "INBOX:9", threadId: "a1:t1", rfcMessageId: null,
        fromAddress: "bob@x.com", toAddresses: ["me@example.com"], subject: "Lunch", bodyText: "Still on?",
        isFromOperator: false, folder: "inbox", sentAt: 500,
      })
      .run();
    // Shown as the newest message the operator received, not the older one.
    expect(listed(db)).toContain("a1:m9");
    expect(listed(db)).not.toContain("a1:m1");
  });

  it("is the number the tree shows, under any scope", () => {
    const db = testDb();
    seed(db);
    for (const scope of [{}, { accountId: "a1" }, { accountId: "a1", since: 400 }, { accountId: "a2" }] as const) {
      expect({ scope, n: folderCounts(db, scope).unopened }).toEqual({ scope, n: listed(db, scope).length });
    }
  });

  it("says nothing about Sent, which has no such row", () => {
    const db = testDb();
    seed(db);
    // The status is an inbox idea; asking Sent for it narrows nothing.
    expect(ids(listInboxMessages(db, { folder: "sent", status: "unopened" }))).toEqual(ids(listInboxMessages(db, { folder: "sent" })));
  });
});

describe("a money side with nothing in scope", () => {
  // The web drops such a side before it reaches any of these; core's part of
  // the bargain is that the count and the list agree on whatever it is given.
  it("counts and lists the same, whichever side is asked for", () => {
    const db = testDb();
    seed(db);
    for (const finance of ["income", "expense"] as const) {
      const scope = { accountId: "a1", finance } as const;
      expect({ finance, n: folderCounts(db, scope).unopened }).toEqual({
        finance,
        n: listInboxMessages(db, { ...scope, status: "unopened" }).length,
      });
      expect({ finance, n: folderCounts(db, scope).needsReply }).toEqual({
        finance,
        n: listInboxMessages(db, { ...scope, status: "needs_reply" }).length,
      });
    }
    // Nothing in the fixture carries a money verdict, so both sides are empty
    // and both say so — which is the state the web has to notice and drop.
    expect(folderCounts(db, { accountId: "a1", finance: "income" }).unopened).toBe(0);
    expect(folderCounts(db, { accountId: "a1" }).unopened).toBe(3);
  });
});

describe("Mark all opened", () => {
  const listed = (db: ReturnType<typeof testDb>, scope = {}) => ids(listInboxMessages(db, { ...scope, status: "unopened" }));

  it("names every thread the list would show, and nothing else", () => {
    const db = testDb();
    seed(db);
    expect(unopenedThreadIds(db, { accountId: "a1" }).sort()).toEqual(["a1:t1", "a1:t2", "a1:t4"]);
    // The scope narrows it the way it narrows the list.
    expect(unopenedThreadIds(db, { accountId: "a2" })).toEqual([]);
    expect(unopenedThreadIds(db, { accountId: "a1", since: 400 }).sort()).toEqual(["a1:t4"]);
  });

  it("empties the list in one go, and undo puts it back exactly", () => {
    const db = testDb();
    seed(db);
    // One thread was opened long ago; the others never.
    markThreadOpened(db, "a1:t1", 50);
    const before = listed(db).sort();
    expect(before).toHaveLength(3);

    const previous = markThreadsOpened(db, unopenedThreadIds(db, {}), 1000);
    expect(listed(db)).toEqual([]);
    expect(previous.find((p) => p.threadId === "a1:t1")).toEqual({ threadId: "a1:t1", openedAt: 50, markedAt: 1000 });
    expect(previous.filter((p) => p.openedAt === null)).toHaveLength(2);

    restoreThreadOpens(db, previous);
    expect(listed(db).sort()).toEqual(before);
    // The thread that had been opened before keeps that time, not none.
    expect(unopenedThreadIds(db, {}).sort()).toEqual(["a1:t1", "a1:t2", "a1:t4"]);
  });

  it("only touches the threads it was given", () => {
    const db = testDb();
    seed(db);
    markThreadsOpened(db, ["a1:t1"], 1000);
    expect(listed(db).sort()).toEqual(["a1:m2", "a1:m3"]);
  });

  it("acts on the scope on screen, not the whole inbox", () => {
    const db = testDb();
    seed(db);
    const narrow = { accountId: "a1", since: 400 } as const;
    markThreadsOpened(db, unopenedThreadIds(db, narrow), 1000);
    expect(listed(db, narrow)).toEqual([]);
    // Everything outside the window is untouched.
    expect(listed(db, { accountId: "a1" }).sort()).toEqual(["a1:m1", "a1:m2"]);
  });

  it("undo keeps a thread the operator opened by hand after the mark (2026-09-14)", () => {
    const db = testDb();
    seed(db);
    const previous = markThreadsOpened(db, unopenedThreadIds(db, {}), 1000);
    expect(listed(db)).toEqual([]);
    // They read t1 themselves after pressing the button.
    markThreadOpened(db, "a1:t1", 2000);
    restoreThreadOpens(db, previous);
    // t1 stays opened at their time; the others go back to never.
    expect(unopenedThreadIds(db, {}).sort()).toEqual(["a1:t2", "a1:t4"]);
    expect(threadOpensOf(db, ["a1:t1"])).toEqual({ "a1:t1": 2000 });
  });

  it("acts across every window: the whole inbox, not just the days on screen (2026-09-14)", () => {
    const db = testDb();
    seed(db);
    // What the action does now: the scope minus its window.
    const scope = { accountId: "a1", since: 400 };
    const { since: _since, ...whole } = scope;
    void _since;
    markThreadsOpened(db, unopenedThreadIds(db, whole), 1000);
    expect(listed(db, { accountId: "a1" })).toEqual([]);
  });

  it("says nothing and does nothing for an empty set", () => {
    const db = testDb();
    seed(db);
    expect(markThreadsOpened(db, [], 1000)).toEqual([]);
    expect(listed(db)).toHaveLength(3);
    restoreThreadOpens(db, []);
    expect(listed(db)).toHaveLength(3);
  });
});

describe("Safe to delete", () => {
  const listed = (db: ReturnType<typeof testDb>, scope = {}) => ids(listInboxMessages(db, { ...scope, status: "disposable" }));

  /** m2 is a deck nobody needs twice; m1 is a person asking a question. */
  function junkmail(db: ReturnType<typeof testDb>) {
    db.update(sorts).set({ wants: "bin", }).where(eq(sorts.messageId, "a1:m2")).run();
  }

  it("holds what the sorter said nobody will need again, and nothing else", () => {
    const db = testDb();
    seed(db);
    junkmail(db);
    expect(listed(db)).toEqual(["a1:m2"]);
  });

  it("leaves out mail with no verdict at all, however quiet it looks", () => {
    const db = testDb();
    seed(db);
    junkmail(db);
    // m3 is unsorted; an empty verdict is not permission to delete.
    expect(listed(db)).not.toContain("a1:m3");
  });

  it("says nothing about Sent, Deleted items or Junk, which have no such row", () => {
    const db = testDb();
    seed(db);
    junkmail(db);
    for (const folder of ["sent", "trash", "junk"] as const) {
      expect(ids(listInboxMessages(db, { folder, status: "disposable" }))).toEqual(ids(listInboxMessages(db, { folder })));
    }
  });

  it("is the number the tree shows, under any scope", () => {
    const db = testDb();
    seed(db);
    junkmail(db);
    db.update(sorts).set({ wants: "knowing" }).where(eq(sorts.messageId, "a1:m1")).run();
    const project = createProject(db, "a1", "Consulting", "client work");
    fileThread(db, "a1:t2", project.id);

    const scopes = [
      {},
      { accountId: "a1" },
      { accountId: "a1", since: 340 },
      { accountId: "a1", projectId: project.id },
      { accountId: "a1", projectId: UNFILED_KEY },
      { accountId: "a2" },
    ] as const;
    for (const scope of scopes) {
      expect({ scope, n: folderCounts(db, scope).disposable }).toEqual({ scope, n: listed(db, scope).length });
    }
  });

  it("counts across every inbox when no inbox is chosen", () => {
    const db = testDb();
    seed(db);
    junkmail(db);
    db.insert(accounts).values({ id: "a2", provider: "imap", email: "work@example.com", displayName: null, createdAt: 1 }).run();
    db.insert(threads).values({ id: "a2:t9", accountId: "a2", providerThreadId: "t9", subject: "Sale", lastMessageAt: 800, lastFromOperator: false }).run();
    db.insert(messages)
      .values({
        ...base, id: "a2:m9", accountId: "a2", providerMessageId: "INBOX:9", threadId: "a2:t9", rfcMessageId: null,
        fromAddress: "sale@shop.com", toAddresses: ["work@example.com"], subject: "Sale", bodyText: "50% off.",
        isFromOperator: false, folder: "inbox", sentAt: 800,
      })
      .run();
    db.insert(sorts)
      .values({ messageId: "a2:m9", wants: "bin", scheduling: false, category: null, finance: "none",  reason: "a promotion", model: "x", labeledAt: null, createdAt: 1 })
      .run();

    expect(folderCounts(db, {}).disposable).toBe(2);
    expect(folderCounts(db, { accountId: "a1" }).disposable).toBe(1);
    expect(listed(db).sort()).toEqual(["a1:m2", "a2:m9"]);
  });
});

describe("Delete all", () => {
  it("names every thread the list would show, once each, and nothing else", () => {
    const db = testDb();
    seed(db);
    db.update(sorts).set({ wants: "bin", }).where(eq(sorts.messageId, "a1:m2")).run();
    expect(disposableThreadIds(db, { accountId: "a1" })).toEqual(["a1:t2"]);
    expect(disposableThreadIds(db, { accountId: "a2" })).toEqual([]);
    // The window narrows it the way it narrows the list.
    expect(disposableThreadIds(db, { accountId: "a1", since: 400 })).toEqual([]);
  });

  it("says a thread once however many of its messages are safe to delete", () => {
    const db = testDb();
    seed(db);
    db.insert(messages)
      .values({
        ...base, id: "a1:m8", accountId: "a1", providerMessageId: "INBOX:8", threadId: "a1:t2", rfcMessageId: null,
        fromAddress: "carol@x.com", toAddresses: ["me@example.com"], subject: "Deck", bodyText: "One more thing.",
        isFromOperator: false, folder: "inbox", sentAt: 360,
      })
      .run();
    db.insert(sorts)
      .values({ messageId: "a1:m8", wants: "bin", scheduling: false, category: null, finance: "none",  reason: "a digest", model: "x", labeledAt: null, createdAt: 1 })
      .run();
    db.update(sorts).set({ wants: "bin" }).where(eq(sorts.messageId, "a1:m2")).run();

    // Two rows in the list and in the tree's count, one thread to delete.
    expect(listInboxMessages(db, { status: "disposable" })).toHaveLength(2);
    expect(folderCounts(db, {}).disposable).toBe(2);
    expect(disposableThreadIds(db, {})).toEqual(["a1:t2"]);
  });

  it("says nothing for an inbox with nothing safe to delete", () => {
    const db = testDb();
    seed(db);
    expect(disposableThreadIds(db, {})).toEqual([]);
  });
});

/**
 * Safe to delete reaches back past the live line (operator, 2026-09-18).
 *
 * `liveOnly` was added to stop back-filled history flooding Need to reply,
 * and applied to all four status rows at once. On this row flooding is the
 * point: it was hiding most of a real mailbox from the one list whose job is
 * to clear it out.
 */
describe("Safe to delete and the live line", () => {
  it("lists mail from long before the inbox was connected", () => {
    const db = testDb();
    seed(db);
    // Sent a year before this account existed, which no other status row shows.
    const connected = db.select().from(accounts).where(eq(accounts.id, "a1")).get()!.createdAt;
    const old = connected - 365 * 86_400_000;
    db.insert(messages)
      .values({
        ...base, id: "a1:mold", accountId: "a1", providerMessageId: "INBOX:old", threadId: "a1:told", rfcMessageId: null,
        fromAddress: "news@vendor.com", toAddresses: ["me@example.com"], subject: "Last year in robotics",
        bodyText: "A newsletter.", isFromOperator: false, folder: "inbox", sentAt: old, receivedAt: old,
      })
      .run();
    db.insert(threads)
      .values({ id: "a1:told", accountId: "a1", providerThreadId: "told", subject: "Last year in robotics", lastMessageAt: old, lastFromOperator: false })
      .run();
    db.insert(sorts)
      .values({ messageId: "a1:mold", wants: "bin", scheduling: false, category: null, finance: "none",  reason: "a newsletter", model: "x", labeledAt: null, createdAt: 1 })
      .run();

    expect(disposableThreadIds(db, {})).toContain("a1:told");
    expect(folderCounts(db, {}).disposable).toBeGreaterThan(0);
    // The rows that exist to say the operator owes something still do not
    // reach back: that is what the live line is for.
    expect(listInboxMessages(db, { status: "needs_reply" }).map((r) => r.message.id)).not.toContain("a1:mold");
  });
});

/**
 * The same button over the Hidden list (operator, 2026-09-18: "for the
 * hidden tab please build a button that allows me to delete all"). Hidden
 * threads were out of the way but still in the mailbox, with no way to clear
 * them out short of unhiding each one first.
 */
describe("Delete all, over Hidden", () => {
  it("names the hidden threads and nothing that is merely safe to delete", () => {
    const db = testDb();
    seed(db);
    db.update(sorts).set({ wants: "bin" }).where(eq(sorts.messageId, "a1:m2")).run();
    db.update(threads).set({ hiddenAt: 500 }).where(eq(threads.id, "a1:t1")).run();

    expect(hiddenThreadIds(db, {})).toEqual(["a1:t1"]);
    // The two lists do not overlap: a hidden thread has left the mailbox's
    // sorting rows, so Safe to delete never offers it as well.
    expect(disposableThreadIds(db, {})).toEqual(["a1:t2"]);
  });

  it("follows the inbox and the window, the way the list above it does", () => {
    const db = testDb();
    seed(db);
    db.update(threads).set({ hiddenAt: 500 }).where(eq(threads.id, "a1:t1")).run();

    expect(hiddenThreadIds(db, { accountId: "a1" })).toEqual(["a1:t1"]);
    expect(hiddenThreadIds(db, { accountId: "a2" })).toEqual([]);
    expect(hiddenThreadIds(db, { since: 400 })).toEqual([]);
  });

  it("says nothing when nothing is hidden", () => {
    const db = testDb();
    seed(db);
    expect(hiddenThreadIds(db, {})).toEqual([]);
  });
});

/**
 * Chats that need a reply are from people the operator knows, and recent
 * (operator, 2026-09-14: "there shouldn't be 217 need to reply"). Nothing
 * from before an inbox was live reaches the status rows at all.
 */
describe("Need to reply for chats: people you know, recently", () => {
  const DAY = 86_400_000;
  const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);
  function seedChats(db: ReturnType<typeof testDb>, connectedAt = NOW - 5 * DAY) {
    db.insert(accounts).values({ id: "im", provider: "imessage", email: "messages:me", displayName: null, createdAt: connectedAt }).run();
    const t = (id: string, subject: string, at: number) => ({ id: `im:${id}`, accountId: "im", providerThreadId: id, subject, lastMessageAt: at, lastFromOperator: false });
    const m = (id: string, threadId: string, from: string, subject: string, at: number, mine = false) => ({
      ...base,
      id: `im:${id}`,
      accountId: "im",
      providerMessageId: id,
      threadId: `im:${threadId}`,
      rfcMessageId: null,
      fromAddress: from,
      toAddresses: ["me"],
      subject,
      bodyText: "hi",
      isFromOperator: mine,
      folder: "messages" as const,
      sentAt: at,
    });
    db.insert(threads).values([t("nat", "Grace", NOW - DAY), t("code", "60754", NOW - DAY), t("pretty", "\u202a+1 (415) 555\u20110133\u202c", NOW - DAY), t("old", "Ben", NOW - 20 * DAY), t("num", "+15551234567", NOW - 2 * DAY), t("hist", "Aunt", NOW - 40 * DAY)]).run();
    db.insert(messages)
      .values([
        m("n1", "nat", "grace@icloud.com", "Grace", NOW - DAY),
        m("c1", "code", "60754", "60754", NOW - DAY),
        m("p1", "pretty", "+14155550133", "\u202a+1 (415) 555\u20110133\u202c", NOW - DAY),
        m("o1", "old", "ben@icloud.com", "Ben", NOW - 20 * DAY),
        // A bare number the operator has written to is someone they know.
        m("u0", "num", "me", "+15551234567", NOW - 3 * DAY, true),
        m("u1", "num", "+15551234567", "+15551234567", NOW - 2 * DAY),
        m("h1", "hist", "aunt@icloud.com", "Aunt", NOW - 40 * DAY),
      ])
      .run();
  }
  const need = (db: ReturnType<typeof testDb>) => listInboxMessages(db, { folder: "messages", status: "needs_reply", now: NOW }).map((r) => r.thread.subject).sort();

  it("keeps a named friend and a number the operator has answered; drops short codes, pretty numbers and quiet chats", () => {
    const db = testDb();
    seedChats(db);
    expect(need(db)).toEqual(["+15551234567", "Grace"]);
  });

  it("a formatted number is no name: it is safe to delete, not a reply to make", () => {
    const db = testDb();
    seedChats(db);
    expect(disposableThreadIds(db, { folder: "messages" }).sort()).toEqual(["im:code", "im:pretty"]);
  });

  it("a chat older than the reply window has gone quiet", () => {
    const db = testDb();
    seedChats(db);
    expect(listInboxMessages(db, { folder: "messages", status: "needs_reply", now: NOW + 14 * DAY }).map((r) => r.thread.subject)).toEqual([]);
  });

  it("history from before the inbox was live never reaches a status row, whatever the window", () => {
    const db = testDb();
    // Connected today: live from 30 days ago. Aunt's text is 40 days old.
    seedChats(db, NOW);
    expect(unopenedThreadIds(db, { folder: "messages" })).not.toContain("im:hist");
    expect(disposableThreadIds(db, { folder: "messages" })).not.toContain("im:hist");
    // Still in the plain Messages list, and still searchable.
    expect(listInboxMessages(db, { folder: "messages" }).map((r) => r.thread.subject)).toContain("Aunt");
    expect(folderCounts(db, { now: NOW }).texts.unopened).toBe(listInboxMessages(db, { folder: "messages", status: "unopened" }).length);
  });
});
