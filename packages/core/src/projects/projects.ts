import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { now, type Db } from "../db/client";
import { projectAssignments, projectGroups, projects, type ProjectGroupRow, type ProjectRow } from "../db/schema";
import { NO_PROJECT } from "../sort/types";

export type { ProjectGroupRow, ProjectRow };

/** How a group is named wherever a project id could stand: in a link, a cookie, a count's key. */
export const GROUP_PREFIX = "group:";

/** The key a group goes by in links, cookies and counts. */
export function groupKey(groupId: string): string {
  return `${GROUP_PREFIX}${groupId}`;
}

/** The group id a key names, or null when the key is a project or Unfiled. */
export function groupIdOf(key: string | undefined): string | null {
  return key?.startsWith(GROUP_PREFIX) ? key.slice(GROUP_PREFIX.length) : null;
}

export const MAX_PROJECT_GROUPS = 12;

/** Reserved: what a message with no project reads as. Never an operator project. */
export const UNFILED = "Unfiled";

export const MAX_PROJECTS = 24;
export const MAX_PROJECT_NAME_LENGTH = 40;
/**
 * A project description is read by the sorter on every message, from a cached
 * system block, so its length costs almost nothing after the first call. The
 * limit is here to keep a description a description rather than a document.
 */
export const MAX_PROJECT_DESCRIPTION_LENGTH = 600;

/** Name and description only: what the embedder reads to place a message. */
export interface Project {
  name: string;
  description: string;
}

/**
 * The list "Add starter projects" offers on an empty inbox. They are examples,
 * meant to be edited or deleted: the description is what gets embedded, so a
 * project earns its place by describing mail the operator actually gets
 * (spec 10d). People and domains are left out on purpose.
 */
export const STARTER_PROJECTS: Project[] = [
  {
    name: "Clients",
    description: "Live client work. Statements of work, deliverables, invoices, scheduling with people at client companies.",
  },
  {
    name: "Money",
    description: "Bills, invoices, receipts, bank and card notices, tax correspondence, anything about money owed or owed to me.",
  },
  {
    name: "Legal and admin",
    description: "Contracts, insurance, licences, government and institutional notices, anything with a deadline attached to a form.",
  },
  {
    name: "Recruiting",
    description: "Candidates, introductions, interview scheduling, offers, and the threads that follow them.",
  },
  {
    name: "Suppliers and tools",
    description: "Vendors, SaaS subscriptions, renewals, support tickets, outage notices.",
  },
  {
    name: "Personal",
    description: "Friends and family, travel, appointments, anything that is not work.",
  },
];

/**
 * The project one message is filed under, by name, or `None` when nothing
 * claimed it. The name is what a model is shown and what a model answers
 * with, so the eval baseline and the trickle model's examples both read it
 * from here rather than each spelling out the join (spec 10d).
 */
export function assignedProjectName(db: Db, messageId: string): string {
  const row = db
    .select({ name: projects.name })
    .from(projectAssignments)
    .leftJoin(projects, eq(projects.id, projectAssignments.projectId))
    .where(eq(projectAssignments.messageId, messageId))
    .get();
  return row?.name ?? NO_PROJECT;
}

/** One inbox's projects in the operator's order. */
export function listProjects(db: Db, accountId: string): ProjectRow[] {
  return db.select().from(projects).where(eq(projects.accountId, accountId)).orderBy(asc(projects.position)).all();
}

export interface ProjectInput {
  /** Present for a project the operator is keeping (possibly renamed); absent for a new one. */
  id?: string;
  name: string;
  description: string;
}

/**
 * Replaces one inbox's whole ordered list in a transaction, so the editor
 * can add, rename, reorder, and delete in a single Save. A rename keeps
 * every filed message, because assignments point at the id. A delete sends
 * its messages to Unfiled and keeps `source`, so a hand-filed message the
 * operator later un-projects is still not up for grabs by the next pass.
 * Throws a readable Error the UI can show as-is.
 */
export function saveProjects(db: Db, accountId: string, items: ProjectInput[], clock: () => number = now): void {
  const cleaned = items.map((item) => ({
    id: item.id,
    name: item.name.trim(),
    description: item.description.trim(),
  }));
  validate(cleaned);

  const at = clock();
  db.transaction((tx) => {
    writeProjects(tx, accountId, cleaned, at);
  });
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The body of a Save: deletes what is gone, renames and reorders what is
 * kept, inserts what is new. Returns each item's id, in the order given.
 * Validates first, so it is safe to call inside a caller's transaction.
 */
function writeProjects(tx: Tx, accountId: string, items: ProjectInput[], at: number): string[] {
  const cleaned = items.map((item) => ({ id: item.id, name: item.name.trim(), description: item.description.trim() }));
  validate(cleaned);
  const existing = tx.select().from(projects).where(eq(projects.accountId, accountId)).all();
  const byId = new Map(existing.map((p) => [p.id, p]));
  const kept = new Set(cleaned.filter((c) => c.id && byId.has(c.id)).map((c) => c.id!));

  for (const row of existing) {
    if (kept.has(row.id)) continue;
    // The assignments have to let go of the row before it can be deleted.
    tx.update(projectAssignments).set({ projectId: null }).where(eq(projectAssignments.projectId, row.id)).run();
    tx.delete(projects).where(eq(projects.id, row.id)).run();
  }

  const ids: string[] = [];
  let position = 0;
  for (const item of cleaned) {
    const previous = item.id ? byId.get(item.id) : undefined;
    if (previous) {
      tx.update(projects)
        .set({ name: item.name, description: item.description, position })
        .where(eq(projects.id, previous.id))
        .run();
      ids.push(previous.id);
    } else {
      const id = randomUUID();
      tx.insert(projects).values({ id, accountId, name: item.name, description: item.description, position, createdAt: at }).run();
      ids.push(id);
    }
    position++;
  }
  return ids;
}

/** The thread picker's "New project…": one project, appended to the end of this inbox's list. */
export function createProject(db: Db, accountId: string, name: string, description: string, clock: () => number = now): ProjectRow {
  const cleaned = { name: name.trim(), description: description.trim() };
  const existing = listProjects(db, accountId);
  validate([...existing.map((p) => ({ id: p.id, name: p.name, description: p.description })), cleaned]);

  const row = {
    id: randomUUID(),
    accountId,
    name: cleaned.name,
    description: cleaned.description,
    position: existing.length,
    createdAt: clock(),
    groupId: null,
  };
  db.insert(projects).values(row).run();
  return row;
}

/** Appends the starters this inbox does not already have, by name. Returns how many were added. */
export function addStarterProjects(db: Db, accountId: string, clock: () => number = now): number {
  const existing = listProjects(db, accountId);
  const have = new Set(existing.map((p) => p.name.toLowerCase()));
  const missing = STARTER_PROJECTS.filter((p) => !have.has(p.name.toLowerCase()));
  if (missing.length === 0) return 0;
  const at = clock();
  db.insert(projects)
    .values(
      missing.map((p, i) => ({
        id: randomUUID(),
        accountId,
        name: p.name,
        description: p.description,
        position: existing.length + i,
        createdAt: at,
      })),
    )
    .run();
  return missing.length;
}

/** One inbox's project groups in the operator's order (2026-09-15). */
export function listProjectGroups(db: Db, accountId: string): ProjectGroupRow[] {
  return db.select().from(projectGroups).where(eq(projectGroups.accountId, accountId)).orderBy(asc(projectGroups.position)).all();
}

export interface ProjectGroupInput {
  /** Present for a group being kept (possibly renamed); absent for a new one. */
  id?: string;
  /** What the editor calls this group before it has an id, so projects can name it. */
  key: string;
  name: string;
}

/**
 * The projects editor's one Save with groups (2026-09-15): the groups, then
 * the projects, each project naming its group by the editor's key. A group
 * left out is deleted and its projects stand on their own; nothing filed
 * moves, because mail stays under its project. One transaction, so a bad
 * name leaves everything as it was.
 */
export function saveProjectsWithGroups(
  db: Db,
  accountId: string,
  items: (ProjectInput & { groupKey?: string | null })[],
  groups: ProjectGroupInput[],
  clock: () => number = now,
): void {
  const cleanedGroups = groups.map((g) => ({ ...g, name: g.name.trim() }));
  validateGroups(cleanedGroups);
  const keys = new Set(cleanedGroups.map((g) => g.key));
  for (const item of items) {
    if (item.groupKey && !keys.has(item.groupKey)) throw new Error(`"${item.name}" is in a group that is not on the list.`);
  }
  const at = clock();
  db.transaction((tx) => {
    const existing = tx.select().from(projectGroups).where(eq(projectGroups.accountId, accountId)).all();
    const byId = new Map(existing.map((g) => [g.id, g]));
    const idByKey = new Map<string, string>();
    let position = 0;
    for (const g of cleanedGroups) {
      if (g.id && byId.has(g.id)) {
        tx.update(projectGroups).set({ name: g.name, position }).where(eq(projectGroups.id, g.id)).run();
        idByKey.set(g.key, g.id);
      } else {
        const id = randomUUID();
        tx.insert(projectGroups).values({ id, accountId, name: g.name, position, createdAt: at }).run();
        idByKey.set(g.key, id);
      }
      position++;
    }
    const kept = new Set(idByKey.values());
    // Projects let go of a group before it goes.
    for (const row of existing) {
      if (kept.has(row.id)) continue;
      tx.update(projects).set({ groupId: null }).where(eq(projects.groupId, row.id)).run();
      tx.delete(projectGroups).where(eq(projectGroups.id, row.id)).run();
    }
    const ids = writeProjects(tx, accountId, items, at);
    items.forEach((item, i) => {
      const groupId = item.groupKey ? (idByKey.get(item.groupKey) ?? null) : null;
      tx.update(projects).set({ groupId }).where(eq(projects.id, ids[i]!)).run();
    });
  });
}

function validateGroups(groups: { name: string }[]): void {
  if (groups.length > MAX_PROJECT_GROUPS) throw new Error(`Keep it to ${MAX_PROJECT_GROUPS} groups or fewer.`);
  const seen = new Set<string>();
  for (const g of groups) {
    if (!g.name) throw new Error("Every group needs a name.");
    if (g.name.length > MAX_PROJECT_NAME_LENGTH) throw new Error(`"${g.name}" is longer than ${MAX_PROJECT_NAME_LENGTH} characters.`);
    const key = g.name.toLowerCase();
    if (seen.has(key)) throw new Error(`The group "${g.name}" is listed twice.`);
    seen.add(key);
  }
}

/** One project by id, scoped to its inbox so a stale link cannot file across accounts. */
export function getProject(db: Db, accountId: string, projectId: string): ProjectRow | null {
  return db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.accountId, accountId)))
    .get() ?? null;
}

function validate(items: ProjectInput[]): void {
  if (items.length > MAX_PROJECTS) throw new Error(`Keep it to ${MAX_PROJECTS} projects or fewer.`);
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.name) throw new Error("Every project needs a name.");
    if (item.name.length > MAX_PROJECT_NAME_LENGTH) throw new Error(`"${item.name}" is longer than ${MAX_PROJECT_NAME_LENGTH} characters.`);
    if (item.description.length > MAX_PROJECT_DESCRIPTION_LENGTH) {
      throw new Error(`The description for "${item.name}" is longer than ${MAX_PROJECT_DESCRIPTION_LENGTH} characters.`);
    }
    const key = item.name.toLowerCase();
    if (key === UNFILED.toLowerCase()) throw new Error(`"${UNFILED}" is reserved for mail that belongs to no project.`);
    if (seen.has(key)) throw new Error(`"${item.name}" is listed twice.`);
    seen.add(key);
  }
}
