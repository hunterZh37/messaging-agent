import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { now, type Db } from "../db/client";
import { alexItems, type AlexItemRow } from "../db/schema";
import { addToAlex, alexConnected, AlexNotConnected, type AlexConfig, type AlexItem } from "./client";

export type { AlexItemRow };

/** What the row records as its title; both kinds carry one. */
export function titleOf(item: AlexItem): string {
  return item.title;
}

/** When the item is for: an actionable's day, or an event's start. */
function whenOf(item: AlexItem): { whenISO: string; endISO: string | null } {
  if (item.kind === "actionable") return { whenISO: item.startISO ?? item.dayISO, endISO: item.endISO ?? null };
  return { whenISO: item.startISO, endISO: item.endISO };
}

/** Everything handed to Alex off one thread, oldest first. */
export function listAlexItems(db: Db, threadId: string): AlexItemRow[] {
  return db.select().from(alexItems).where(eq(alexItems.threadId, threadId)).orderBy(asc(alexItems.createdAt)).all();
}

/**
 * Hands one item to Alex and records what happened, either way (spec 10e:
 * "Every attempt, success or failure, is a row"). A refusal is returned rather
 * than thrown, so the thread can show it beside a retry; only a missing token
 * throws, because that is a thing to fix in `.env` rather than to retry.
 */
export async function sendToAlex(
  db: Db,
  threadId: string,
  item: AlexItem,
  config: AlexConfig,
  clock: () => number = now,
  fetchImpl: typeof fetch = fetch,
): Promise<AlexItemRow> {
  if (!alexConnected(config)) throw new AlexNotConnected();
  const { whenISO, endISO } = whenOf(item);
  const base = { id: randomUUID(), threadId, kind: item.kind, title: titleOf(item), whenISO, endISO, createdAt: clock() };
  try {
    const written = await addToAlex(item, config, fetchImpl);
    const row = { ...base, status: "added" as const, alexId: written.id, error: null };
    db.insert(alexItems).values(row).run();
    return row;
  } catch (e) {
    const row = { ...base, status: "failed" as const, alexId: null, error: e instanceof Error ? e.message : "Alex could not do it." };
    db.insert(alexItems).values(row).run();
    return row;
  }
}

/**
 * A failed row, sent again as it was. The old row stays: it is the record of
 * the attempt. `link` is passed in rather than read back from the row,
 * because it is the same address either way, worked out from the thread
 * (2026-09-23): a retry that lost the way back would be a quieter bug than a
 * retry that failed.
 */
export async function retryAlexItem(
  db: Db,
  id: string,
  config: AlexConfig,
  clock: () => number = now,
  fetchImpl: typeof fetch = fetch,
  link?: string,
): Promise<AlexItemRow | null> {
  const row = db.select().from(alexItems).where(eq(alexItems.id, id)).get();
  if (!row || row.status === "added") return null;
  const item = itemOf(row);
  return sendToAlex(db, row.threadId, link ? { ...item, link } : item, config, clock, fetchImpl);
}

/** A row read back as the item it was, so a retry sends exactly what failed. */
export function itemOf(row: AlexItemRow): AlexItem {
  if (row.kind === "event") return { kind: "event", title: row.title, startISO: row.whenISO, endISO: row.endISO ?? row.whenISO };
  return row.endISO
    ? { kind: "actionable", title: row.title, dayISO: row.whenISO, startISO: row.whenISO, endISO: row.endISO }
    : { kind: "actionable", title: row.title, dayISO: row.whenISO };
}
