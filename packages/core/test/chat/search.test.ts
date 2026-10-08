import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../helpers/db";
import { backfillSearchIndex, ftsQuery, indexMessageForSearch, mergeHits, rebuildSearchIndexIfStale, searchMessages } from "../../src/chat/search";
import type { SearchHit } from "../../src/chat/types";
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

describe("stemming", () => {
  it("answers one word for a word's other endings (operator, 2026-10-07)", () => {
    const db = testDb();
    seedMail(db, [{ id: "m1", subject: "Invoicing for September", fromName: "Sam", fromAddress: "sam@example.com", bodyText: "The invoices are attached." }]);
    expect(searchMessages(db, "invoice").map((h) => h.messageId)).toEqual(["a1:m1"]);
    expect(searchMessages(db, "invoicing").map((h) => h.messageId)).toEqual(["a1:m1"]);
    expect(searchMessages(db, "invoices").map((h) => h.messageId)).toEqual(["a1:m1"]);
  });

  it("tells two identifiers apart, so a stemmer that collapsed them would fail here", () => {
    // Querying the literal indexed text proves nothing on its own — the
    // query is stemmed the same way as the index, so both sides would be
    // mangled identically. Two distinct identifiers, and a search for one
    // that must not return the other, is what actually pins the property.
    const db = testDb();
    seedMail(db, [
      { id: "m2", subject: "Receipt", fromName: null, fromAddress: "noreply@example.com", bodyText: "Your case number is IOE8022910507." },
      { id: "m3", subject: "Receipt", fromName: null, fromAddress: "noreply@example.com", bodyText: "Your case number is IOE8022910599." },
    ]);
    expect(searchMessages(db, "IOE8022910507").map((h) => h.messageId)).toEqual(["a1:m2"]);
    expect(searchMessages(db, "IOE8022910599").map((h) => h.messageId)).toEqual(["a1:m3"]);
  });

  it("tells two senders apart by address the same way", () => {
    const db = testDb();
    seedMail(db, [
      { id: "m4", fromName: "Sam", fromAddress: "sam@example.com", bodyText: "see attached" },
      { id: "m5", fromName: "Jordan", fromAddress: "jordan@example.com", bodyText: "see attached" },
    ]);
    expect(searchMessages(db, "sam@example.com").map((h) => h.messageId)).toEqual(["a1:m4"]);
    expect(searchMessages(db, "jordan@example.com").map((h) => h.messageId)).toEqual(["a1:m5"]);
  });
});

describe("rebuildSearchIndexIfStale", () => {
  it("drops an index built with the old tokenizer, and leaves a current one alone", () => {
    const db = testDb();
    db.$client.exec("DROP TABLE messages_fts");
    db.$client.exec(
      "CREATE VIRTUAL TABLE messages_fts USING fts5(message_id UNINDEXED, subject, from_name, from_address, body, tokenize='unicode61')",
    );
    expect(rebuildSearchIndexIfStale(db)).toBe(true);
    expect(rebuildSearchIndexIfStale(db)).toBe(false);
  });
});

describe("mergeHits", () => {
  const hit = (id: string): SearchHit => ({ messageId: id, threadId: `t-${id}`, subject: id, from: "sam@example.com", sentAt: 0, snippet: "", channel: "mail" });

  it("leads with the best word match, so an identifier is never pushed off", () => {
    const merged = mergeHits([hit("w1"), hit("w2")], [hit("m1"), hit("m2")], 10);
    expect(merged.map((h) => h.messageId)).toEqual(["w1", "m1", "w2", "m2"]);
  });

  it("shows a message found both ways once, at its better place", () => {
    const merged = mergeHits([hit("a")], [hit("a"), hit("b")], 10);
    expect(merged.map((h) => h.messageId)).toEqual(["a", "b"]);
  });

  /**
   * Celeste's one cue for telling a message that merely reads alike from
   * one that actually has the operator's words (2026-10-07): a message
   * found only by the keyword half is "words", only by the meaning half is
   * "meaning", and found by both — genuinely stronger evidence than either
   * alone — is "both", however the two halves happened to overlap.
   */
  it("marks each hit with how it was found: words, meaning, or both", () => {
    const merged = mergeHits([hit("w1"), hit("both1")], [hit("both1"), hit("m1")], 10);
    const byId = new Map(merged.map((h) => [h.messageId, h.match]));
    expect(byId.get("w1")).toBe("words");
    expect(byId.get("m1")).toBe("meaning");
    expect(byId.get("both1")).toBe("both");
  });

  /**
   * `hit()` above is exactly the shape a `SearchHit` had before `match`
   * existed: no such field at all. A hit from before this branch, were one
   * ever to reach `mergeHits`, is shaped the same way, and must pass
   * through tagged rather than this function assuming the field is already
   * there to read (2026-10-07).
   */
  it("tags a hit that arrived with no match field of its own", () => {
    const merged = mergeHits([hit("w1")], [], 10);
    expect(merged).toEqual([{ ...hit("w1"), match: "words" }]);
  });

  it("fills from whichever half has more when the other runs out", () => {
    expect(mergeHits([hit("w1")], [hit("m1"), hit("m2"), hit("m3")], 10).map((h) => h.messageId)).toEqual(["w1", "m1", "m2", "m3"]);
    expect(mergeHits([hit("w1"), hit("w2")], [], 10).map((h) => h.messageId)).toEqual(["w1", "w2"]);
  });

  it("never returns more than asked for, and keeps the best of each half within it", () => {
    const merged = mergeHits([hit("w1"), hit("w2"), hit("w3")], [hit("m1"), hit("m2")], 3);
    expect(merged.map((h) => h.messageId)).toEqual(["w1", "m1", "w2"]);
  });

  it("is empty when neither half found anything", () => {
    expect(mergeHits([], [], 10)).toEqual([]);
  });
});

/**
 * The score the operator hovers (spec 2026-10-07). Both halves of the search
 * already compute the numbers it needs — the keyword index its bm25, the
 * vector table its distance — and until now both were thrown away.
 */
describe("scores on hits", () => {
  const hit = (id: string): SearchHit => ({
    messageId: id,
    threadId: `t-${id}`,
    subject: id,
    from: "sam@example.com",
    sentAt: 0,
    snippet: "",
    channel: "mail",
  });

  it("carries a score and its parts through the merge", () => {
    const w = { ...hit("a"), parts: { words: -9, ageMs: 0, inSubject: false } };
    const merged = mergeHits([w], [], 10);
    expect(merged[0]!.score).toBeGreaterThan(0);
    expect(merged[0]!.parts!.words).toBe(-9);
  });

  it("gives a message both halves found the parts of both", () => {
    const w = { ...hit("a"), parts: { words: -9, ageMs: 0, inSubject: false } };
    const m = { ...hit("a"), parts: { meaning: 0.2, ageMs: 0, inSubject: false } };
    const merged = mergeHits([w], [m], 10);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.match).toBe("both");
    expect(merged[0]!.parts).toMatchObject({ words: -9, meaning: 0.2 });
    // And the score reflects both, so it beats either half on its own.
    expect(merged[0]!.score!).toBeGreaterThan(mergeHits([w], [], 10)[0]!.score!);
  });

  /** A hit that was never ranked keeps its match but gets no score to invent. */
  it("leaves a hit with no parts unscored", () => {
    const merged = mergeHits([hit("a")], [], 10);
    expect(merged[0]!.score).toBeUndefined();
    expect(merged[0]!.parts).toBeUndefined();
  });
});

describe("what a real search knows about its hits", () => {
  it("keeps the bm25 the index already ranked by, and notices a subject match", () => {
    const db = testDb();
    seedMail(db, [{ id: "m1", subject: "Invoice for September", bodyText: "the invoice is attached" }]);
    const [hit] = searchMessages(db, "invoice");
    expect(hit!.parts!.words).toBeLessThan(0);
    expect(hit!.parts!.inSubject).toBe(true);
    expect(hit!.parts!.ageMs).toBeGreaterThanOrEqual(0);
  });

  it("says the words were not in the subject when they were only in the body", () => {
    const db = testDb();
    seedMail(db, [{ id: "m1", subject: "September", bodyText: "the invoice is attached" }]);
    expect(searchMessages(db, "invoice")[0]!.parts!.inSubject).toBe(false);
  });

  /**
   * bm25 sums over the query's terms, so a four-word question produces a far
   * bigger number than a one-word one for the same quality of match. Captured
   * raw, every result of a sentence-shaped question clamped to 100 (measured
   * against the real index, whole-branch review 2026-10-07).
   */
  it("keeps a per-term bm25, so a long question does not score everything alike", () => {
    const db = testDb();
    seedMail(db, [{ id: "m1", subject: "September", bodyText: "your statement is available to download" }]);
    const one = searchMessages(db, "statement")[0]!.parts!.words!;
    const four = searchMessages(db, "your statement is available")[0]!.parts!.words!;
    // Per term, a four-word match of ordinary words is not four times better
    // than a one-word match; raw, it would be.
    expect(Math.abs(four)).toBeLessThan(Math.abs(one) * 2);
  });

  it("says which of the operator's terms it actually found", () => {
    const db = testDb();
    seedMail(db, [{ id: "m1", subject: "September", bodyText: "the invoice is attached" }]);
    const [hit] = searchMessages(db, "invoice");
    expect(hit!.parts!.matched).toEqual(["invoice"]);
  });

  /** A search with filters and no words ranked nothing, so there is nothing to score. */
  it("leaves a filters-only result unranked", () => {
    const db = testDb();
    seedMail(db, [{ id: "m1", subject: "September", bodyText: "anything", fromAddress: "sam@example.com" }]);
    const [hit] = searchMessages(db, "", { from: "sam" });
    expect(hit).toBeDefined();
    expect(hit!.parts).toBeUndefined();
  });
});
