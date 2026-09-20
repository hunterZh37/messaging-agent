import { and, asc, desc, eq, gte, isNull, lt, ne, sql } from "drizzle-orm";
import { now, type Db } from "../db/client";
import { accounts, messages, projectAssignments, sorts, type MessageRow } from "../db/schema";
import { listProjects } from "../projects/projects";
import { listCategories, type Category } from "./categories";
import { NO_PROJECT, type Sorter, type SortInput, type SortProject } from "./types";
import { OPERATOR } from "./corrections";

/**
 * One stored message as the sorter reads it. The id and the inbox ride along
 * so the trickle model can find what this inbox already judged (spec 7a);
 * every other sorter ignores them.
 */
function sortInputFor(m: MessageRow, operatorAddress: string | null = null): SortInput {
  return {
    id: m.id,
    accountId: m.accountId,
    fromAddress: m.fromAddress,
    fromName: m.fromName,
    toAddresses: m.toAddresses,
    ccAddresses: m.ccAddresses,
    operatorAddress,
    subject: m.subject,
    bodyText: m.bodyText,
    attachmentNames: m.attachmentNames,
    sentAt: m.sentAt,
  };
}

/**
 * This inbox's own address, cached per run: it is what decides whether a
 * message was addressed to the operator or merely copied to a list they are
 * on, and looking it up once per message would be a query per message.
 */
function addressOf(db: Db, cache: Map<string, string | null>, accountId: string): string | null {
  const held = cache.get(accountId);
  if (held !== undefined) return held;
  const row = db.select({ email: accounts.email }).from(accounts).where(eq(accounts.id, accountId)).get();
  const email = row?.email ?? null;
  cache.set(accountId, email);
  return email;
}

/** The automatic sorter only looks at mail from the last 30 days (spec 5, "Backfill and retention"). */
export const AUTO_SORT_DAYS = 30;
/** The age line the automatic sorter works down to: anything older waits for `sortOlder`. */
export function autoSortMinSentAt(at: number = now()): number {
  return at - AUTO_SORT_DAYS * 86_400_000;
}

/**
 * Sorts unsorted inbound mail. `minSentAt` is the age line: mail older than
 * it is left unsorted, because a deep backfill is one model call per message
 * and the operator asks for those explicitly with `sortOlder` (spec 5).
 */
export async function sortPending(
  db: Db,
  sorter: Sorter,
  criteria: string,
  opts: { limit?: number; minSentAt?: number; clock?: () => number } = {},
): Promise<{ sorted: number; failed: number }> {
  const clock = opts.clock ?? now;
  const categories = operatorCategories(db);
  const projectCache = new Map<string, SortProject[]>();
  const addressCache = new Map<string, string | null>();
  // Only the inbox is sorted: Sent is the operator's own words, Deleted items
  // and Junk are decisions the provider already made (spec 10a), and a chat
  // needs a reply by a rule, not a verdict (2026-09-11).
  const conditions = [isNull(sorts.messageId), eq(messages.isFromOperator, false), eq(messages.folder, "inbox")];
  if (opts.minSentAt !== undefined) conditions.push(gte(messages.sentAt, opts.minSentAt));
  const pending = db
    .select({ m: messages })
    .from(messages)
    .leftJoin(sorts, eq(sorts.messageId, messages.id))
    .where(and(...conditions))
    .orderBy(messages.sentAt)
    .limit(opts.limit ?? 500)
    .all()
    .map((r) => r.m);

  let sorted = 0;
  let failed = 0;
  for (const m of pending) {
    try {
      const r = await sorter.sort(criteria, categories, projectsFor(db, projectCache, m.accountId), sortInputFor(m, addressOf(db, addressCache, m.accountId)));
      const written = db
        .insert(sorts)
        .values({
          messageId: m.id,
          wants: r.wants,
          scheduling: r.scheduling,
          // Nothing bound for the bin carries a sub-category: it is a way of
          // filing what the operator will look at, and they will not look at
          // this (operator, 2026-09-19).
          category: r.wants === "bin" ? null : r.category,
          // Money moves whatever the rung, so this is kept for every message
          // (spec 7).
          finance: r.finance,
          reason: r.reason,
          model: sorter.model,
          labeledAt: null,
          createdAt: clock(),
        })
        // Two passes can meet on one message: the trickle sort after a sync
        // and a backlog run, or a re-file, both reading it as unsorted before
        // either has written (seen in the log as "UNIQUE constraint failed",
        // 2026-09-11). The verdict already there stands; this one is dropped.
        .onConflictDoNothing()
        .run();
      if (written.changes === 0) continue;
      fileFromSorter(db, m.id, projectsFor(db, projectCache, m.accountId), r.project, projectIdsByName(db, m.accountId), clock());
      sorted++;
    } catch (err) {
      failed++;
      console.error(`sort failed for ${m.id}:`, (err as Error).message);
    }
  }
  return { sorted, failed };
}

/** Inbound mail older than `sentBefore` that the automatic pass left without a verdict: the "Sort N older" count. */
export function countUnsortedBefore(db: Db, sentBefore: number, opts: { accountId?: string } = {}): number {
  const conditions = [isNull(sorts.messageId), eq(messages.isFromOperator, false), eq(messages.folder, "inbox"), lt(messages.sentAt, sentBefore)];
  if (opts.accountId) conditions.push(eq(messages.accountId, opts.accountId));
  return (
    db
      .select({ count: sql<number>`count(*)` })
      .from(messages)
      .leftJoin(sorts, eq(sorts.messageId, messages.id))
      .where(and(...conditions))
      .get()?.count ?? 0
  );
}

/**
 * Runs the sorter over backfilled mail older than `opts.before`, oldest
 * first. Only the operator asks for this: every message here is one model
 * call, which is why the automatic pass skipped them.
 */
export async function sortOlder(
  db: Db,
  sorter: Sorter,
  criteria: string,
  opts: { before: number; limit?: number; accountId?: string; clock?: () => number },
): Promise<{ sorted: number; failed: number }> {
  const clock = opts.clock ?? now;
  const categories = operatorCategories(db);
  const projectCache = new Map<string, SortProject[]>();
  const addressCache = new Map<string, string | null>();
  const conditions = [isNull(sorts.messageId), eq(messages.isFromOperator, false), eq(messages.folder, "inbox"), lt(messages.sentAt, opts.before)];
  if (opts.accountId) conditions.push(eq(messages.accountId, opts.accountId));
  const older = db
    .select({ m: messages })
    .from(messages)
    .leftJoin(sorts, eq(sorts.messageId, messages.id))
    .where(and(...conditions))
    .orderBy(asc(messages.sentAt))
    .limit(opts.limit ?? 50)
    .all()
    .map((r) => r.m);

  let sorted = 0;
  let failed = 0;
  for (const m of older) {
    try {
      const r = await sorter.sort(criteria, categories, projectsFor(db, projectCache, m.accountId), sortInputFor(m, addressOf(db, addressCache, m.accountId)));
      const written = db
        .insert(sorts)
        .values({
          messageId: m.id,
          wants: r.wants,
          scheduling: r.scheduling,
          category: r.wants === "bin" ? null : r.category,
          finance: r.finance,
          reason: r.reason,
          model: sorter.model,
          labeledAt: null,
          createdAt: clock(),
        })
        // Two passes can meet on one message: the trickle sort after a sync
        // and a backlog run, or a re-file, both reading it as unsorted before
        // either has written (seen in the log as "UNIQUE constraint failed",
        // 2026-09-11). The verdict already there stands; this one is dropped.
        .onConflictDoNothing()
        .run();
      if (written.changes === 0) continue;
      fileFromSorter(db, m.id, projectsFor(db, projectCache, m.accountId), r.project, projectIdsByName(db, m.accountId), clock());
      sorted++;
    } catch (err) {
      failed++;
      console.error(`sort failed for ${m.id}:`, (err as Error).message);
    }
  }
  return { sorted, failed };
}

/** The operator's sub-categories as the sorter wants them: name and description, in priority order. */
function operatorCategories(db: Db): Category[] {
  return listCategories(db).map((c) => ({ name: c.name, description: c.description }));
}

/**
 * One inbox's projects, read once per pass rather than once per message: a
 * sort run is hundreds of model calls and the list does not change under it.
 */
function projectsFor(db: Db, cache: Map<string, SortProject[]>, accountId: string): SortProject[] {
  const cached = cache.get(accountId);
  if (cached) return cached;
  const rows = listProjects(db, accountId).map((p) => ({ name: p.name, description: p.description }));
  cache.set(accountId, rows);
  return rows;
}

/**
 * Records the sorter's project for one message (spec 10d). A name it did not
 * recognise, or "None", means no project. What the operator filed by hand is
 * never touched: a manual filing outranks every later pass, which is what
 * makes "Move to project…" stick.
 */
function fileFromSorter(
  db: Db,
  messageId: string,
  projects: SortProject[],
  named: string,
  byName: Map<string, string>,
  at: number,
): void {
  const existing = db.select({ source: projectAssignments.source }).from(projectAssignments).where(eq(projectAssignments.messageId, messageId)).get();
  if (existing?.source === "manual") return;
  const projectId = named === NO_PROJECT ? null : (byName.get(named) ?? null);
  db.insert(projectAssignments)
    .values({ messageId, projectId, source: "sorter", score: null, assignedAt: at })
    .onConflictDoUpdate({
      target: projectAssignments.messageId,
      set: { projectId, source: "sorter", score: null, assignedAt: at },
    })
    .run();
}

/** Project ids by name for one inbox, to turn the sorter's answer into a row. */
function projectIdsByName(db: Db, accountId: string): Map<string, string> {
  return new Map(listProjects(db, accountId).map((p) => [p.name, p.id]));
}

/**
 * Re-files mail that is already sorted important, updating its category and
 * reason in place. Importance itself and every draft stay as they are: this
 * runs after the operator edits their categories, and re-deciding what is
 * important would quietly withdraw mail they have already been shown.
 */
export async function resortImportant(
  db: Db,
  sorter: Sorter,
  criteria: string,
  opts: { limit?: number } = {},
): Promise<{ resorted: number; failed: number }> {
  const categories = operatorCategories(db);
  const projectCache = new Map<string, SortProject[]>();
  const addressCache = new Map<string, string | null>();
  const rows = db
    .select({ m: messages })
    .from(messages)
    .innerJoin(sorts, eq(sorts.messageId, messages.id))
    .where(and(ne(sorts.wants, "bin"), ne(sorts.model, OPERATOR), eq(messages.folder, "inbox")))
    .orderBy(messages.sentAt)
    .limit(opts.limit ?? 500)
    .all()
    .map((r) => r.m);

  let resorted = 0;
  let failed = 0;
  for (const m of rows) {
    try {
      const r = await sorter.sort(criteria, categories, projectsFor(db, projectCache, m.accountId), sortInputFor(m, addressOf(db, addressCache, m.accountId)));
      db.update(sorts).set({ category: r.category, finance: r.finance, reason: r.reason, model: sorter.model }).where(eq(sorts.messageId, m.id)).run();
      fileFromSorter(db, m.id, projectsFor(db, projectCache, m.accountId), r.project, projectIdsByName(db, m.accountId), now());
      resorted++;
    } catch (err) {
      failed++;
      console.error(`re-sort failed for ${m.id}:`, (err as Error).message);
    }
  }
  return { resorted, failed };
}

/**
 * Re-runs the sorter over every inbound message in the window that already
 * has a verdict, updating what the sorter can be wrong about — the
 * sub-category, which way money moves, whether a reply or a meeting is being
 * asked for, and the reason — in place. Importance is deliberately not
 * touched: it is the operator's standing default, and re-deciding it would
 * quietly withdraw mail they have already been shown. This is what the
 * header's "Re-sort window" asks for, so a new sub-category or a corrected
 * finance rule reaches mail that arrived before it.
 */
export async function resortWindow(
  db: Db,
  sorter: Sorter,
  criteria: string,
  opts: { since: number; accountId?: string; limit?: number },
): Promise<{ resorted: number; failed: number }> {
  const categories = operatorCategories(db);
  const projectCache = new Map<string, SortProject[]>();
  const addressCache = new Map<string, string | null>();
  // A verdict the operator set by hand is theirs. A pass that quietly
  // overwrote it would teach them not to trust the ones that stuck
  // (operator, 2026-09-20).
  const conditions = [eq(messages.isFromOperator, false), eq(messages.folder, "inbox"), ne(sorts.model, OPERATOR), gte(messages.sentAt, opts.since)];
  if (opts.accountId) conditions.push(eq(messages.accountId, opts.accountId));
  // Mail the sorter has not filed yet goes first, then the longest-ago filed,
  // so repeated presses of Re-file walk the whole window instead of re-reading
  // the newest batch every time.
  const rows = db
    .select({ m: messages })
    .from(messages)
    .innerJoin(sorts, eq(sorts.messageId, messages.id))
    .leftJoin(projectAssignments, eq(projectAssignments.messageId, messages.id))
    .where(and(...conditions))
    .orderBy(sql`case when ${projectAssignments.messageId} is null then 0 else 1 end`, asc(projectAssignments.assignedAt), desc(messages.sentAt))
    .limit(opts.limit ?? 200)
    .all()
    .map((r) => r.m);

  let resorted = 0;
  let failed = 0;
  for (const m of rows) {
    try {
      const r = await sorter.sort(criteria, categories, projectsFor(db, projectCache, m.accountId), sortInputFor(m, addressOf(db, addressCache, m.accountId)));
      db.update(sorts)
        .set({ wants: r.wants, category: r.wants === "bin" ? null : r.category, finance: r.finance, scheduling: r.scheduling, reason: r.reason, model: sorter.model })
        .where(eq(sorts.messageId, m.id))
        .run();
      fileFromSorter(db, m.id, projectsFor(db, projectCache, m.accountId), r.project, projectIdsByName(db, m.accountId), now());
      resorted++;
    } catch (err) {
      failed++;
      console.error(`re-sort failed for ${m.id}:`, (err as Error).message);
    }
  }
  return { resorted, failed };
}

/**
 * Re-reads the mail sitting under "Need to reply" — the newest message of
 * every thread the sorter says is waiting on the operator — and lets it
 * answer again under the current rules. This is what makes a change to the
 * needs-reply rule reach mail already judged by the old one, without paying
 * for the whole inbox. Importance is left alone, for the same reason
 * `resortWindow` leaves it: it is the operator's standing default, and
 * re-deciding it would withdraw mail they have already been shown.
 * `cleared` is how many stopped asking for a reply.
 */
export async function resortNeedsReply(
  db: Db,
  sorter: Sorter,
  criteria: string,
  opts: { accountId?: string; limit?: number } = {},
): Promise<{ resorted: number; cleared: number }> {
  const categories = operatorCategories(db);
  const projectCache = new Map<string, SortProject[]>();
  const addressCache = new Map<string, string | null>();
  const conditions = [
    eq(messages.isFromOperator, false),
    eq(messages.folder, "inbox"),
    eq(sorts.wants, "reply"),
    ne(sorts.model, OPERATOR),
    sql`${messages.id} = (
      select m.id from messages m
      where m.thread_id = ${messages.threadId}
      order by m.sent_at desc, m.id desc
      limit 1
    )`,
  ];
  if (opts.accountId) conditions.push(eq(messages.accountId, opts.accountId));

  const rows = db
    .select({ m: messages })
    .from(messages)
    .innerJoin(sorts, eq(sorts.messageId, messages.id))
    .where(and(...conditions))
    .orderBy(desc(messages.sentAt))
    .limit(opts.limit ?? 200)
    .all()
    .map((r) => r.m);

  let resorted = 0;
  let cleared = 0;
  for (const m of rows) {
    try {
      const r = await sorter.sort(criteria, categories, projectsFor(db, projectCache, m.accountId), sortInputFor(m, addressOf(db, addressCache, m.accountId)));
      db.update(sorts)
        // This pass asks one question: is a reply still owed? So a thread
        // that no longer needs one comes down a rung, never all the way to
        // the bin. Nothing was asked about whether it is worth keeping, and
        // quietly moving mail that was recently owed an answer into Safe to
        // delete is the wrong direction to be wrong in.
        .set({ wants: r.wants === "reply" ? "reply" : "knowing", category: r.category, finance: r.finance, scheduling: r.scheduling, reason: r.reason, model: sorter.model })
        .where(eq(sorts.messageId, m.id))
        .run();
      fileFromSorter(db, m.id, projectsFor(db, projectCache, m.accountId), r.project, projectIdsByName(db, m.accountId), now());
      resorted++;
      if (r.wants !== "reply") cleared++;
    } catch (err) {
      console.error(`re-sort failed for ${m.id}:`, (err as Error).message);
    }
  }
  return { resorted, cleared };
}
