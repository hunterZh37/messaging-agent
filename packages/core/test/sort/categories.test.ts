import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "../helpers/db";
import { accounts, messages, sorts, threads } from "../../src/db/schema";
import {
  OTHER,
  categoryNames,
  listCategories,
  saveCategories,
  seedCategoriesIfEmpty,
} from "../../src/sort/categories";

function seedSort(db: ReturnType<typeof testDb>, id: string, category: string | null) {
  db.insert(accounts).values({ id: `acc-${id}`, provider: "imap", email: `${id}@example.com`, displayName: null, createdAt: 1 }).run();
  db.insert(threads).values({ id: `t-${id}`, accountId: `acc-${id}`, providerThreadId: `t-${id}`, subject: "s", lastMessageAt: 1, lastFromOperator: false }).run();
  db.insert(messages)
    .values({
      id, accountId: `acc-${id}`, providerMessageId: id, threadId: `t-${id}`, rfcMessageId: null,
      fromAddress: "bob@example.com", fromName: null, toAddresses: [], ccAddresses: [], subject: "s",
      bodyText: "b", snippet: null, attachmentNames: [], isFromOperator: false, sentAt: 1, receivedAt: 1,
    })
    .run();
  db.insert(sorts).values({ messageId: id, important: true, needsReply: false, scheduling: false, category, reason: "r", model: "x", labeledAt: null, createdAt: 1 }).run();
}

describe("seedCategoriesIfEmpty", () => {
  it("inserts the starter list once and never again", () => {
    const db = testDb();
    seedCategoriesIfEmpty(db, () => 5);
    expect(listCategories(db).map((c) => c.name)).toEqual(["Needs reply", "Scheduling", "Action required", "FYI"]);
    expect(listCategories(db).map((c) => c.position)).toEqual([0, 1, 2, 3]);
    saveCategories(db, [{ name: "Money", description: "bills." }]);
    seedCategoriesIfEmpty(db, () => 5);
    expect(listCategories(db).map((c) => c.name)).toEqual(["Money"]);
  });
});

describe("saveCategories", () => {
  it("replaces the list in order, assigning positions and ids", () => {
    const db = testDb();
    saveCategories(db, [
      { name: "Money", description: "bills and invoices." },
      { name: "Family", description: "anything from family." },
    ]);
    const rows = listCategories(db);
    expect(rows.map((c) => [c.name, c.position])).toEqual([["Money", 0], ["Family", 1]]);
    expect(rows.every((c) => c.id.length > 0)).toBe(true);
  });

  it("reorders existing categories, keeping their ids", () => {
    const db = testDb();
    saveCategories(db, [{ name: "Money", description: "bills." }, { name: "Family", description: "kin." }]);
    const [money, family] = listCategories(db);
    saveCategories(db, [
      { id: family!.id, name: family!.name, description: family!.description },
      { id: money!.id, name: money!.name, description: money!.description },
    ]);
    expect(listCategories(db).map((c) => c.name)).toEqual(["Family", "Money"]);
    expect(listCategories(db).map((c) => c.id)).toEqual([family!.id, money!.id]);
  });

  it("renames a category and re-labels the sorts filed under the old name", () => {
    const db = testDb();
    saveCategories(db, [{ name: "Money", description: "bills." }]);
    const money = listCategories(db)[0]!;
    seedSort(db, "m1", "Money");
    seedSort(db, "m2", "Other");
    saveCategories(db, [{ id: money.id, name: "Finance", description: "bills." }]);
    expect(db.select().from(sorts).where(eq(sorts.messageId, "m1")).get()?.category).toBe("Finance");
    expect(db.select().from(sorts).where(eq(sorts.messageId, "m2")).get()?.category).toBe("Other");
  });

  it("moves the sorts of a deleted category to Other", () => {
    const db = testDb();
    saveCategories(db, [{ name: "Money", description: "bills." }, { name: "Family", description: "kin." }]);
    const family = listCategories(db)[1]!;
    seedSort(db, "m1", "Money");
    seedSort(db, "m2", "Family");
    saveCategories(db, [{ id: family.id, name: "Family", description: "kin." }]);
    expect(db.select().from(sorts).where(eq(sorts.messageId, "m1")).get()?.category).toBe(OTHER);
    expect(db.select().from(sorts).where(eq(sorts.messageId, "m2")).get()?.category).toBe("Family");
  });

  it("accepts an empty list, clearing every category", () => {
    const db = testDb();
    saveCategories(db, [{ name: "Money", description: "bills." }]);
    seedSort(db, "m1", "Money");
    saveCategories(db, []);
    expect(listCategories(db)).toEqual([]);
    expect(db.select().from(sorts).where(eq(sorts.messageId, "m1")).get()?.category).toBe(OTHER);
  });

  it("rejects duplicates, empty names, over-long names, Other, and more than 12", () => {
    const db = testDb();
    expect(() => saveCategories(db, [{ name: "Money", description: "a." }, { name: "money", description: "b." }])).toThrow(/twice/i);
    expect(() => saveCategories(db, [{ name: "  ", description: "a." }])).toThrow(/name/i);
    expect(() => saveCategories(db, [{ name: "x".repeat(41), description: "a." }])).toThrow(/40/);
    expect(() => saveCategories(db, [{ name: "other", description: "a." }])).toThrow(/reserved/i);
    expect(() => saveCategories(db, [{ name: "Money", description: "x".repeat(601) }])).toThrow(/600/);
    expect(() => saveCategories(db, Array.from({ length: 13 }, (_, i) => ({ name: `C${i}`, description: "d." })))).toThrow(/12/);
    expect(listCategories(db)).toEqual([]);
  });

  it("trims names and descriptions and allows an empty description", () => {
    const db = testDb();
    saveCategories(db, [{ name: "  Money  ", description: "  bills.  " }, { name: "Family", description: "" }]);
    expect(listCategories(db).map((c) => [c.name, c.description])).toEqual([["Money", "bills."], ["Family", ""]]);
  });
});

describe("description length", () => {
  it("has room for a description a model actually wrote", () => {
    const db = testDb();
    // The seeded lists run to a few hundred characters; 200 rejected every Save.
    saveCategories(db, [{ name: "Money", description: "x".repeat(600) }]);
    expect(listCategories(db)[0]!.description).toHaveLength(600);
  });
});

describe("money category names", () => {
  it("lets the operator name a category Income or Expense: money is its own axis", () => {
    const db = testDb();
    saveCategories(db, [{ name: "Income", description: "what comes in." }, { name: "Expense", description: "what goes out." }]);
    expect(listCategories(db).map((c) => c.name)).toEqual(["Income", "Expense"]);
  });
});

describe("categoryNames", () => {
  it("returns the names in order with Other last", () => {
    expect(categoryNames([{ name: "Money", description: "d" }, { name: "Family", description: "d" }])).toEqual(["Money", "Family", OTHER]);
    expect(categoryNames([])).toEqual([OTHER]);
  });
});
