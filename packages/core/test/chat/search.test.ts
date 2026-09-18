import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../helpers/db";
import { backfillSearchIndex, ftsQuery, indexMessageForSearch, searchMessages } from "../../src/chat/search";
import { accounts, messages, projectAssignments } from "../../src/db/schema";
import { createProject } from "../../src/projects/projects";
import { seedMail } from "./seed";

describe("searchMessages", () => {
  it("finds a message by a word in its body, subject or sender", () => {
    const db = testDb();
    seedMail(db, [
      { id: "m1", subject: "March invoice", fromName: "Acme Billing", fromAddress: "billing@acme.test", bodyText: "The invoice for March is attached, due on the 30th." },
      { id: "m2", subject: "Lunch", bodyText: "Are you free on Thursday?" },
    ]);

    expect(searchMessages(db, "invoice").map((h) => h.messageId)).toEqual(["a1:m1"]);
    expect(searchMessages(db, "acme").map((h) => h.messageId)).toEqual(["a1:m1"]);
    expect(searchMessages(db, "thursday").map((h) => h.messageId)).toEqual(["a1:m2"]);

    const hit = searchMessages(db, "invoice")[0]!;
    expect(hit.threadId).toBe("a1:t-m1");
    expect(hit.from).toBe("Acme Billing <billing@acme.test>");
    expect(hit.snippet).toContain("invoice");
  });

  it("drops quoted history from the indexed body", () => {
    const db = testDb();
    seedMail(db, [{ id: "m1", bodyText: "Sounds good.\n\nOn Tue, Bob wrote:\n> what about the kingfisher photos" }]);
    expect(searchMessages(db, "kingfisher")).toEqual([]);
    expect(searchMessages(db, "sounds")).toHaveLength(1);
  });

  it("requires every term, then falls back to any of them", () => {
    const db = testDb();
    seedMail(db, [
      { id: "m1", subject: "Invoice", bodyText: "invoice for the studio" },
      { id: "m2", subject: "Studio", bodyText: "studio booking confirmed" },
    ]);
    expect(searchMessages(db, "invoice studio").map((h) => h.messageId)).toEqual(["a1:m1"]);
    // Nothing holds both, so both are offered rather than nothing.
    expect(searchMessages(db, "invoice booking").map((h) => h.messageId).sort()).toEqual(["a1:m1", "a1:m2"]);
  });

  it("treats the operator's punctuation as words, never as syntax", () => {
    const db = testDb();
    seedMail(db, [{ id: "m1", fromAddress: "billing@acme.test", bodyText: "your NEAR term plan" }]);
    for (const query of ['"unclosed quote', "billing@acme.test", "NEAR(a b)", "plan AND OR *", "(){}[]", "^:-"]) {
      expect(() => searchMessages(db, query)).not.toThrow();
    }
    expect(searchMessages(db, "billing@acme.test").map((h) => h.messageId)).toEqual(["a1:m1"]);
    // NEAR is a word here, not an FTS5 operator: the fallback matches on it.
    expect(searchMessages(db, "NEAR(a b)").map((h) => h.messageId)).toEqual(["a1:m1"]);
    expect(searchMessages(db, "!!!")).toEqual([]);
  });

  it("scopes to one inbox when asked", () => {
    const db = testDb();
    seedMail(db, [
      { id: "m1", accountId: "a1", bodyText: "shared word here" },
      { id: "m2", accountId: "a2", bodyText: "shared word there" },
    ]);
    expect(searchMessages(db, "shared")).toHaveLength(2);
    expect(searchMessages(db, "shared", { accountId: "a1" }).map((h) => h.messageId)).toEqual(["a1:m1"]);
    expect(searchMessages(db, "shared", { accountId: "a2" }).map((h) => h.messageId)).toEqual(["a2:m2"]);
  });

  it("honours the limit", () => {
    const db = testDb();
    seedMail(db, Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, bodyText: "repeated word" })));
    expect(searchMessages(db, "repeated", { limit: 2 })).toHaveLength(2);
  });
});

describe("searchMessages filters", () => {
  it("gathers everything from one sender with no words at all", () => {
    const db = testDb();
    seedMail(db, [
      { id: "m1", fromName: "Victoria Chen", fromAddress: "v.chen@lawfirm.test", subject: "Visa", sentAt: 300 },
      { id: "m2", fromName: "Victoria Chen", fromAddress: "v.chen@lawfirm.test", subject: "Documents", sentAt: 200 },
      { id: "m3", fromName: "Bob", fromAddress: "bob@example.com", subject: "Lunch", sentAt: 100 },
    ]);
    const hits = searchMessages(db, "", { from: "victoria" });
    expect(hits.map((h) => h.messageId)).toEqual(["a1:m1", "a1:m2"]);
    // Newest first, since there are no words to rank by.
    expect(hits[0]!.subject).toBe("Visa");
    expect(hits[0]!.snippet).not.toBe("");
    // The address alone finds her too, name or no name.
    expect(searchMessages(db, "", { from: "LAWFIRM.TEST" }).map((h) => h.messageId)).toEqual(["a1:m1", "a1:m2"]);
  });

  it("narrows the words by sender when both are given", () => {
    const db = testDb();
    seedMail(db, [
      { id: "m1", fromName: "Victoria", fromAddress: "v@a.test", bodyText: "the visa appointment" },
      { id: "m2", fromName: "Bob", fromAddress: "bob@b.test", bodyText: "the visa appointment too" },
    ]);
    expect(searchMessages(db, "visa").map((h) => h.messageId).sort()).toEqual(["a1:m1", "a1:m2"]);
    expect(searchMessages(db, "visa", { from: "victoria" }).map((h) => h.messageId)).toEqual(["a1:m1"]);
  });

  it("narrows to one project, with or without words", () => {
    const db = testDb();
    seedMail(db, [
      { id: "m1", bodyText: "shared word" },
      { id: "m2", bodyText: "shared word" },
    ]);
    const project = createProject(db, "a1", "Immigration", "");
    db.insert(projectAssignments).values({ messageId: "a1:m1", projectId: project.id, source: "manual", score: null, assignedAt: 1 }).run();

    expect(searchMessages(db, "shared", { projectId: project.id }).map((h) => h.messageId)).toEqual(["a1:m1"]);
    expect(searchMessages(db, "", { projectId: project.id }).map((h) => h.messageId)).toEqual(["a1:m1"]);
  });

  it("without words and without filters, finds nothing rather than everything", () => {
    const db = testDb();
    seedMail(db, [{ id: "m1", bodyText: "anything" }]);
    expect(searchMessages(db, "")).toEqual([]);
    expect(searchMessages(db, "   ")).toEqual([]);
  });

  it("keeps the account scope when filtering by sender", () => {
    const db = testDb();
    seedMail(db, [
      { id: "m1", accountId: "a1", fromName: "Victoria", fromAddress: "v@a.test" },
      { id: "m2", accountId: "a2", fromName: "Victoria", fromAddress: "v@a.test" },
    ]);
    expect(searchMessages(db, "", { from: "victoria", accountId: "a1" }).map((h) => h.messageId)).toEqual(["a1:m1"]);
  });

  it("never returns more than fifty, whatever it is asked for", () => {
    const db = testDb();
    seedMail(db, Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, fromName: "Victoria", fromAddress: "v@a.test" })));
    expect(searchMessages(db, "", { from: "victoria", limit: 500 })).toHaveLength(50);
  });
});

describe("ftsQuery", () => {
  it("quotes each term and joins them", () => {
    expect(ftsQuery('invoice "acme"', "AND")).toBe('"invoice" AND "acme"');
    expect(ftsQuery("invoice acme", "OR")).toBe('"invoice" OR "acme"');
    expect(ftsQuery("  ?! ", "AND")).toBeNull();
  });
});

describe("indexMessageForSearch", () => {
  it("re-indexing a message leaves one row, not two", () => {
    const db = testDb();
    seedMail(db, [{ id: "m1", bodyText: "first wording" }]);
    const row = db.select().from(messages).all()[0]!;
    indexMessageForSearch(db, { ...row, bodyText: "second wording" });
    expect(searchMessages(db, "wording")).toHaveLength(1);
    expect(searchMessages(db, "first")).toEqual([]);
    expect(searchMessages(db, "second")).toHaveLength(1);
  });
});

describe("backfillSearchIndex", () => {
  it("indexes what is missing and is a no-op the second time", () => {
    const db = testDb();
    seedMail(db, [{ id: "m1", bodyText: "already indexed" }]);
    db.$client.exec("DELETE FROM messages_fts");
    expect(backfillSearchIndex(db)).toBe(1);
    expect(searchMessages(db, "indexed")).toHaveLength(1);
    expect(backfillSearchIndex(db)).toBe(0);
    expect(searchMessages(db, "indexed")).toHaveLength(1);
  });
});

describe("searchMessages over chats", () => {
  it("finds a WhatsApp text, names its chat, and can stay inside one channel", () => {
    const db = testDb();
    seedMail(db, [{ id: "m1", subject: "Password reset", bodyText: "the password for the portal is in the doc" }]);
    db.insert(accounts).values({ id: "wa", provider: "whatsapp", email: "whatsapp:1", displayName: "WhatsApp", createdAt: 1 }).run();
    seedMail(db, [{ id: "w1", accountId: "wa", subject: "Julia Eligrana", fromName: "Julia Eligrana", fromAddress: "1@s.whatsapp.net", bodyText: "the password is hunter2026" }]);
    db.update(messages).set({ folder: "messages" }).where(eq(messages.id, "wa:w1")).run();
    const all = searchMessages(db, "password");
    expect(all.map((h) => h.messageId).sort()).toEqual(["a1:m1", "wa:w1"]);
    const wa = all.find((h) => h.messageId === "wa:w1")!;
    expect(wa.channel).toBe("whatsapp");
    expect(wa.subject).toBe("WhatsApp chat: Julia Eligrana");
    expect(all.find((h) => h.messageId === "a1:m1")?.channel).toBe("mail");
    expect(searchMessages(db, "password", { channel: "whatsapp" }).map((h) => h.messageId)).toEqual(["wa:w1"]);
    expect(searchMessages(db, "password", { channel: "mail" }).map((h) => h.messageId)).toEqual(["a1:m1"]);
    expect(searchMessages(db, "", { from: "julia", channel: "whatsapp" }).map((h) => h.messageId)).toEqual(["wa:w1"]);
  });

  it("a selected inbox narrows mail and leaves every chat in reach (2026-09-14)", () => {
    const db = testDb();
    seedMail(db, [
      { id: "m1", accountId: "a1", bodyText: "the password is in the doc" },
      { id: "m2", accountId: "a2", bodyText: "the password is on the wiki" },
    ]);
    db.insert(accounts).values({ id: "wa", provider: "whatsapp", email: "whatsapp:1", displayName: "WhatsApp", createdAt: 1 }).run();
    seedMail(db, [{ id: "w1", accountId: "wa", subject: "Keith LAAF", fromName: "Keith LAAF", fromAddress: "1@lid", bodyText: "Username: hunter Password: 9" }]);
    db.update(messages).set({ folder: "messages" }).where(eq(messages.id, "wa:w1")).run();
    expect(searchMessages(db, "password", { accountId: "a1" }).map((h) => h.messageId).sort()).toEqual(["a1:m1", "wa:w1"]);
    expect(searchMessages(db, "", { from: "keith", accountId: "a2" }).map((h) => h.messageId)).toEqual(["wa:w1"]);
    // Inside one inbox, still one inbox for mail.
    expect(searchMessages(db, "password", { accountId: "a1", channel: "mail" }).map((h) => h.messageId)).toEqual(["a1:m1"]);
  });
});
