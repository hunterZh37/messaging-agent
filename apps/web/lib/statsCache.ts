import { sql } from "drizzle-orm";
import { messagingStats, projectStats, relationships, schema, type MessagingStats, type ProjectStats, type Relationship } from "@messaging-agent/core";
import { core } from "./core";
import { RANGES, sinceFor, type RangeKey } from "./statsRanges";

/**
 * The stats page re-derives everything from the message table on every
 * render, and the range chips are links, so each click pays for it again:
 * about 1.6 seconds of it, for numbers that had not moved (operator,
 * 2026-09-17: not snappy).
 *
 * Nothing on that page depends on anything but the messages, so a reading
 * stays good until a message arrives or leaves. That is one indexed row to
 * check, against a second and a half to recompute, and flipping between the
 * four ranges is then instant after the first visit of each.
 */

interface Entry {
  stamp: string;
  value: unknown;
}

const KEY = Symbol.for("celeste.statsCache");
const store = globalThis as unknown as Record<symbol, Map<string, Entry> | undefined>;

function cache(): Map<string, Entry> {
  store[KEY] ??= new Map();
  return store[KEY];
}

/**
 * What the mailbox is at right now: the newest arrival and how many there
 * are. The count is what catches a delete, which moves no timestamp.
 */
export function mailboxStamp(): string {
  const { db } = core();
  const row = db
    .select({
      latest: sql<number | null>`max(${schema.messages.receivedAt})`,
      n: sql<number>`count(*)`,
    })
    .from(schema.messages)
    .get();
  // The day belongs in the stamp too. "90 days" and "12 months" are measured
  // from now, so a reading taken yesterday answers a slightly different
  // question; without this, a quiet mailbox could hold one for days.
  return `${row?.latest ?? 0}:${row?.n ?? 0}:${new Date().toDateString()}`;
}

/** Enough for the four ranges and every reading on them; older entries go. */
const MAX_ENTRIES = 16;

/** `make()` again only when the mailbox has changed since it last ran. */
export function memoWhileUnchanged<T>(key: string, stamp: string, make: () => T): T {
  const map = cache();
  const hit = map.get(key);
  if (hit && hit.stamp === stamp) return hit.value as T;

  const value = make();
  // Re-inserting moves the key to the end, so the oldest is the first out.
  map.delete(key);
  map.set(key, { stamp, value });
  for (const old of map.keys()) {
    if (map.size <= MAX_ENTRIES) break;
    map.delete(old);
  }
  return value;
}

/** The two readings the page draws, each held under its own key. */
export function statsFor(key: RangeKey, stamp: string): MessagingStats {
  return memoWhileUnchanged(`stats:${key}`, stamp, () => messagingStats(core().db, sinceFor(key)));
}

export function relationshipsFor(key: RangeKey, stamp: string): Relationship[] {
  return memoWhileUnchanged(`rel:${key}`, stamp, () => relationships(core().db, sinceFor(key)));
}

export function projectsFor(key: RangeKey, stamp: string): ProjectStats {
  return memoWhileUnchanged(`proj:${key}`, stamp, () => projectStats(core().db, sinceFor(key)));
}

const WARMING = Symbol.for("celeste.statsWarming");
const flag = globalThis as unknown as Record<symbol, boolean | undefined>;

/**
 * Work out all four ranges before anybody asks for one, so the first press of
 * a chip is as quick as the second (operator, 2026-09-17).
 *
 * Each range is a second or so of synchronous SQLite, which would hold up
 * anything else the server were doing, so they are taken one at a time with a
 * pause between rather than in a single block. A range already held for this
 * stamp costs nothing, which is what makes this safe to call again after the
 * mailbox moves.
 */
export async function warmStats(): Promise<void> {
  if (flag[WARMING]) return;
  flag[WARMING] = true;
  try {
    const stamp = mailboxStamp();
    for (const r of RANGES) {
      statsFor(r.key, stamp);
      await new Promise((done) => setTimeout(done, 250));
      relationshipsFor(r.key, stamp);
      await new Promise((done) => setTimeout(done, 250));
      projectsFor(r.key, stamp);
      await new Promise((done) => setTimeout(done, 250));
    }
  } catch {
    // A warm-up is an optimisation. If the database is busy or mid-migration
    // the page will simply compute its own range, which is what it did before.
  } finally {
    flag[WARMING] = false;
  }
}
