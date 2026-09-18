import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { now, type Db } from "../db/client";
import { categories, sorts, type CategoryRow } from "../db/schema";

/** What the sorter needs to know about a sub-category: nothing but the words. */
export interface Category {
  name: string;
  description: string;
}

export type { CategoryRow };

/** Reserved catch-all. Always offered to the sorter, never an operator category. */
export const OTHER = "Other";

/** The header's money filter, which Income and Expense sit under (spec 7). */
export const FINANCE = "Finance";

export const MAX_CATEGORIES = 12;
export const MAX_NAME_LENGTH = 40;
/** Same ceiling as a project description, for the same reason. */
export const MAX_DESCRIPTION_LENGTH = 600;

const STARTER: Category[] = [
  { name: "Needs reply", description: "a real person is waiting on my answer." },
  { name: "Scheduling", description: "proposes, asks for, or changes a meeting time." },
  { name: "Action required", description: "pay, sign, submit, review, or decide by a date; no reply expected." },
  { name: "FYI", description: "important to know, nothing for me to do." },
];

/** The operator's sub-categories in priority order. */
export function listCategories(db: Db): CategoryRow[] {
  return db.select().from(categories).orderBy(asc(categories.position)).all();
}

/**
 * Fills an empty table with the starter list on first run. Once the
 * operator has edited the list — including emptying it deliberately — this
 * would still re-seed an empty table, which is the one case where showing
 * the starters again is better than showing nothing.
 */
export function seedCategoriesIfEmpty(db: Db, clock: () => number = now): void {
  if (db.select({ id: categories.id }).from(categories).limit(1).get()) return;
  const at = clock();
  db.insert(categories)
    .values(STARTER.map((c, i) => ({ id: randomUUID(), name: c.name, description: c.description, position: i, createdAt: at })))
    .run();
}

export interface CategoryInput {
  /** Present for a category the operator is keeping (possibly renamed); absent for a new one. */
  id?: string;
  name: string;
  description: string;
}

/**
 * Replaces the whole ordered list in one transaction, so the editor can
 * add, rename, reorder, and delete in a single Save. Existing sorts follow
 * their category: a rename re-labels them, a delete moves them to `Other`.
 * Throws a readable Error the UI can show as-is.
 */
export function saveCategories(db: Db, items: CategoryInput[], clock: () => number = now): void {
  const cleaned = items.map((item) => ({
    id: item.id,
    name: item.name.trim(),
    description: item.description.trim(),
  }));
  validate(cleaned);

  const at = clock();
  db.transaction((tx) => {
    const existing = tx.select().from(categories).all();
    const byId = new Map(existing.map((c) => [c.id, c]));
    const kept = cleaned.filter((c) => c.id && byId.has(c.id)).map((c) => c.id!);

    // Deleted categories lose their mail to Other before the rows go.
    for (const row of existing) {
      if (!kept.includes(row.id)) {
        tx.update(sorts).set({ category: OTHER }).where(eq(sorts.category, row.name)).run();
      }
    }
    tx.delete(categories).run();

    let position = 0;
    for (const item of cleaned) {
      const previous = item.id ? byId.get(item.id) : undefined;
      const id = previous?.id ?? randomUUID();
      tx.insert(categories)
        .values({ id, name: item.name, description: item.description, position, createdAt: previous?.createdAt ?? at })
        .run();
      if (previous && previous.name !== item.name) {
        tx.update(sorts).set({ category: item.name }).where(eq(sorts.category, previous.name)).run();
      }
      position++;
    }
  });
}

function validate(items: CategoryInput[]): void {
  if (items.length > MAX_CATEGORIES) throw new Error(`Keep it to ${MAX_CATEGORIES} categories or fewer.`);
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.name) throw new Error("Every category needs a name.");
    if (item.name.length > MAX_NAME_LENGTH) throw new Error(`"${item.name}" is longer than ${MAX_NAME_LENGTH} characters.`);
    if (item.description.length > MAX_DESCRIPTION_LENGTH) throw new Error(`The description for "${item.name}" is longer than ${MAX_DESCRIPTION_LENGTH} characters.`);
    const key = item.name.toLowerCase();
    if (key === OTHER.toLowerCase()) throw new Error(`"${OTHER}" is reserved for mail that fits no category.`);
    if (seen.has(key)) throw new Error(`"${item.name}" is listed twice.`);
    seen.add(key);
  }
}

/** The names the sorter may return: the operator's, in order, then `Other`. */
export function categoryNames(cats: Category[]): string[] {
  return [...cats.map((c) => c.name), OTHER];
}
