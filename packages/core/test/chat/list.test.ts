import { describe, it, expect } from "vitest";
import { testDb } from "../helpers/db";
import { listMailForChat, windowStartFor } from "../../src/chat/list";
import { fileThreadsToProject } from "../../src/chat/execute";
import { createProject, listProjects } from "../../src/projects/projects";
import { accounts, messages, projectAssignments, threadOpens } from "../../src/db/schema";
import { eq } from "drizzle-orm";
import { seedMail } from "./seed";

const DAY = 86_400_000;

describe("windowStartFor", () => {
  const now = Date.UTC(2026, 8, 9, 18, 0, 0);
  it("is midnight for today, a span back for 7d and 30d, and nothing for all", () => {
    expect(windowStartFor("all", now)).toBeNull();
    expect(windowStartFor("7d", now)).toBe(now - 7 * DAY);
    expect(windowStartFor("30d", now)).toBe(now - 30 * DAY);
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    expect(windowStartFor("today", now)).toBe(midnight.getTime());
  });
});

describe("listMailForChat", () => {
  const now = 10 * DAY;

  it("answers 'anything new' with the unopened threads, newest first", () => {
    const db = testDb();
    seedMail(db, [
      { id: "m1", subject: "Older", sentAt: now - 2 * DAY },
      { id: "m2", subject: "Newer", sentAt: now - 1 * DAY },
      { id: "m3", subject: "Read already", sentAt: now - 3 * DAY },
      { id: "m4", subject: "Too old", sentAt: now - 20 * DAY },
    ]);
    db.insert(threadOpens).values({ threadId: "a1:t-m3", openedAt: now }).run();

    const rows = listMailForChat(db, { status: "unopened", since: "7d", now });
    if ("unknownProject" in rows) throw new Error("unexpected unknown project");
    expect(rows.map((r) => r.subject)).toEqual(["Newer", "Older"]);
    expect(rows[0]).toMatchObject({ threadId: "a1:t-m2", messageId: "a1:m2", from: "Bob <bob@example.com>", unread: true, project: null });
    expect(rows[0]!.sentAt).toBe(new Date(now - DAY).toISOString());
  });

  it("takes the window it is given", () => {
    const db = testDb();
    seedMail(db, [
      { id: "m1", subject: "Today", sentAt: now },
      { id: "m2", subject: "Last week", sentAt: now - 6 * DAY },
    ]);
    const week = listMailForChat(db, { since: "7d", now }) as { subject: string }[];
    expect(week.map((r) => r.subject)).toEqual(["Today", "Last week"]);
    const all = listMailForChat(db, { since: "all", now }) as { subject: string }[];
    expect(all).toHaveLength(2);
  });

  it("reads sent mail when asked what is waiting on an answer", () => {
    const db = testDb();
    seedMail(db, [
      { id: "m1", subject: "Asked", bodyText: "Could you confirm the date?", isFromOperator: true, sentAt: now - DAY },
      { id: "m2", subject: "Told", bodyText: "Sent you the file.", isFromOperator: true, sentAt: now - DAY },
    ]);
    const rows = listMailForChat(db, { status: "waiting", since: "7d", now }) as { subject: string }[];
    expect(rows.map((r) => r.subject)).toEqual(["Asked"]);
  });

  it("scopes to one inbox and honours the limit", () => {
    const db = testDb();
    seedMail(db, [
      { id: "m1", accountId: "a1", sentAt: now - DAY },
      { id: "m2", accountId: "a2", sentAt: now - DAY },
      { id: "m3", accountId: "a1", sentAt: now - 2 * DAY },
    ]);
    expect(listMailForChat(db, { accountId: "a1", now })).toHaveLength(2);
    expect(listMailForChat(db, { accountId: "a2", now })).toHaveLength(1);
    expect(listMailForChat(db, { limit: 1, now })).toHaveLength(1);
  });

  it("lists the chats whichever inbox is selected (2026-09-14)", () => {
    const db = testDb();
    seedMail(db, [{ id: "m1", accountId: "a1", sentAt: now - DAY }]);
    db.insert(accounts).values({ id: "wa", provider: "whatsapp", email: "whatsapp:1", displayName: "WhatsApp", createdAt: 1 }).run();
    seedMail(db, [{ id: "w1", accountId: "wa", subject: "Keith LAAF", fromName: "Keith LAAF", fromAddress: "1@lid", sentAt: now - DAY }]);
    db.update(messages).set({ folder: "messages" }).where(eq(messages.id, "wa:w1")).run();
    const rows = listMailForChat(db, { folder: "messages", accountId: "a1", now }) as { subject: string }[];
    expect(rows.map((r) => r.subject)).toEqual(["Keith LAAF"]);
    // Mail is still the selected inbox's.
    expect(listMailForChat(db, { accountId: "a2", now })).toHaveLength(0);
  });

  it("names a project it cannot find rather than listing everything", () => {
    const db = testDb();
    seedMail(db, [{ id: "m1", sentAt: now }]);
    expect(listMailForChat(db, { project: "Immigration", accountId: "a1", now })).toEqual({ unknownProject: "Immigration" });

    const project = createProject(db, "a1", "Immigration", "");
    db.insert(projectAssignments).values({ messageId: "a1:m1", projectId: project.id, source: "manual", score: null, assignedAt: 1 }).run();
    const rows = listMailForChat(db, { project: "immigration", accountId: "a1", now }) as { project: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.project).toBe("Immigration");
  });
});

describe("fileThreadsToProject", () => {
  it("creates the project once and files every thread into it", () => {
    const db = testDb();
    seedMail(db, [{ id: "m1" }, { id: "m2" }, { id: "m3" }]);

    const result = fileThreadsToProject(db, ["a1:t-m1", "a1:t-m2", "a1:t-m3"], "Immigration", { create: true });

    expect(result).toEqual({ filed: 3, created: 1 });
    const made = listProjects(db, "a1");
    expect(made).toHaveLength(1);
    expect(made[0]!.name).toBe("Immigration");
    expect(made[0]!.description).toBe("Created from Ask Celeste");
    const filed = db.select().from(projectAssignments).all();
    expect(filed).toHaveLength(3);
    expect(filed.every((a) => a.projectId === made[0]!.id)).toBe(true);
  });

  it("uses a project that already exists, whatever the case of the name", () => {
    const db = testDb();
    seedMail(db, [{ id: "m1" }]);
    const project = createProject(db, "a1", "Immigration", "By hand");

    expect(fileThreadsToProject(db, ["a1:t-m1"], "IMMIGRATION", { create: true })).toEqual({ filed: 1, created: 0 });
    expect(listProjects(db, "a1")).toHaveLength(1);
    expect(db.select().from(projectAssignments).all()[0]!.projectId).toBe(project.id);
  });

  it("refuses a name no inbox has when it was not told to create it", () => {
    const db = testDb();
    seedMail(db, [{ id: "m1" }]);
    expect(fileThreadsToProject(db, ["a1:t-m1"], "Immigration")).toEqual({ error: "No project named Immigration in this inbox." });
    expect(db.select().from(projectAssignments).all()).toHaveLength(0);
  });

  it("says which thread it could not find, and files nothing", () => {
    const db = testDb();
    seedMail(db, [{ id: "m1" }]);
    expect(fileThreadsToProject(db, ["a1:t-m1", "a1:t-gone"], "Immigration", { create: true })).toEqual({ error: "Thread not found: a1:t-gone." });
    expect(listProjects(db, "a1")).toHaveLength(0);
    expect(db.select().from(projectAssignments).all()).toHaveLength(0);
  });

  it("makes the project once per inbox when the threads span two", () => {
    const db = testDb();
    seedMail(db, [{ id: "m1", accountId: "a1" }, { id: "m2", accountId: "a2" }]);
    expect(fileThreadsToProject(db, ["a1:t-m1", "a2:t-m2"], "Immigration", { create: true })).toEqual({ filed: 2, created: 2 });
    expect(listProjects(db, "a1")).toHaveLength(1);
    expect(listProjects(db, "a2")).toHaveLength(1);
  });
});
