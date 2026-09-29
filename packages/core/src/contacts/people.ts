import { notInArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import { now as clockNow } from "../db/client";
import { accounts, messages } from "../db/schema";
import { inboxRowsWhere, type InboxRow } from "../queue/inbox";

/**
 * The people the operator deals with, and the way back to what was said
 * (operator, 2026-09-28: "there should be a feature where I can easily access
 * to the most common thread with contacts I talk to a lot").
 *
 * Read out of the mail and the texts rather than kept in a table, for the
 * same reason the compose suggestions are: a table would be one more thing to
 * keep true. Who the operator deals with changes, so the list follows it —
 * a message counts for less the older it is, and forty this month beat two
 * hundred from two years ago.
 *
 * A person is one row even when they are an address and a number, but only
 * where the address book holds both under one name: that is the only thing
 * that knows they are the same person. Two mails signed the same way are not
 * evidence of anything — half the world signs itself "Support".
 */

/** How long a message keeps half its weight: about six weeks. */
export const HALF_LIFE_MS = 45 * 86_400_000;
/** How many people the sidebar shows (operator, 2026-09-28: eight). */
export const SIDEBAR_PEOPLE = 8;

/** What one message is worth now, by how long ago it was. */
export function weight(sentAt: number, at: number): number {
  return Math.pow(2, -Math.max(0, at - sentAt) / HALF_LIFE_MS);
}

/** Not a person: a group, a broadcast list, a newsletter feed. */
const NOT_A_PERSON = ["@g.us", "@broadcast", "@newsletter"];
/**
 * Machines that write and never read (the compose suggestions demote these;
 * a list of who the operator deals with leaves them out altogether).
 */
const AUTOMATED = /^(no[-._]?reply|donotreply|do[-._]?not[-._]?reply|notifications?|mailer[-._]?daemon|bounces?|postmaster|support|info|admin)[@+.]/;

export interface Person {
  /** The handle this person is addressed by, and the one in their link. */
  key: string;
  name: string | null;
  /** Every handle that is this person: addresses and chat handles. */
  handles: string[];
  /** Which ways they are reached, in a steady order. */
  channels: ("chat" | "mail")[];
  /** The last time anything passed between them and the operator. */
  lastAt: number;
  /** How many messages that is, all time. */
  count: number;
  /** What those messages are worth today, newer ones worth more. */
  score: number;
}

function isChat(handle: string): boolean {
  return handle.endsWith("@lid") || handle.endsWith("@s.whatsapp.net") || !handle.includes("@");
}

/**
 * The digits of a number, last ten, so "+1 (415) 555-0133", "+14155550133"
 * and "14155550133@s.whatsapp.net" are one person. Ten because a country code
 * is written when it is written, and the rest is the number.
 */
function digits(handle: string): string | null {
  const bare = handle.split("@")[0] ?? "";
  const only = bare.replace(/\D/g, "");
  return only.length >= 7 ? only.slice(-10) : null;
}

interface Tally {
  handle: string;
  name: string | null;
  nameAt: number;
  lastAt: number;
  count: number;
  score: number;
}

const held = new WeakMap<object, { at: number; people: Person[] }>();
const HOLD_MS = 60_000;

/** Forget the held list: for a test, or once a sync has brought more in. */
export function forgetPeople(db: Db): void {
  held.delete(db as object);
}

/**
 * Everyone, gathered and weighed. Held for a minute, because the sidebar asks
 * on every page and the sweep is the whole mailbox.
 */
function gather(db: Db, at: number): Person[] {
  const own = new Set(db.select({ email: accounts.email }).from(accounts).all().map((a) => a.email.trim().toLowerCase()));
  // The operator's own handles, which the accounts table does not hold: a
  // chat account is named by its address here, while the texts in it come
  // from the operator's number. Without this the operator was the person
  // they dealt with most, by sixty-seven thousand messages (seen against the
  // real mailbox, 2026-09-28).
  for (const m of db.all<{ handle: string }>(sql`select distinct lower(from_address) as handle from messages where is_from_operator = 1`)) {
    if (m.handle?.trim()) own.add(m.handle.trim());
  }

  const byHandle = new Map<string, Tally>();
  const add = (handle: string, name: string | null, sentAt: number) => {
    const key = handle.trim().toLowerCase();
    if (key === "" || own.has(key)) return;
    if (NOT_A_PERSON.some((suffix) => key.endsWith(suffix))) return;
    if (AUTOMATED.test(key)) return;
    const row = byHandle.get(key) ?? { handle: key, name: null, nameAt: -1, lastAt: 0, count: 0, score: 0 };
    row.count += 1;
    row.score += weight(sentAt, at);
    if (sentAt > row.lastAt) row.lastAt = sentAt;
    if (name?.trim() && sentAt >= row.nameAt) {
      row.name = name.trim();
      row.nameAt = sentAt;
    }
    byHandle.set(key, row);
  };

  for (const m of db.all<{ handle: string; name: string | null; sentAt: number }>(sql`
    select lower(from_address) as handle, from_name as name, sent_at as sentAt from messages
  `)) {
    add(m.handle, m.name, m.sentAt);
  }
  // Who the operator wrote to. Only their own mail is read this way: every
  // message they *receive* carries their own address in `to`, along with
  // whoever else was copied in, so counting those made the operator's own
  // aliases the people they dealt with most and promoted anyone who happened
  // to be cc'd (seen against the real mailbox, 2026-09-28). Someone the
  // operator has written to, or heard from, is someone they talk to; a name
  // in the copy line of somebody else's mail is not.
  for (const m of db.all<{ handle: string; sentAt: number }>(sql`
    select lower(r.value) as handle, m.sent_at as sentAt from messages m, json_each(m.to_addresses) r where m.is_from_operator = 1
    union all
    select lower(r.value) as handle, m.sent_at as sentAt from messages m, json_each(m.cc_addresses) r where m.is_from_operator = 1
  `)) {
    add(m.handle, null, m.sentAt);
  }

  return merge(db, [...byHandle.values()], own);
}

/**
 * The address book's word on who is who. A card is known here by its name,
 * because that is all the table keeps: one name over an address and a number
 * is the operator's own say-so that they belong to one person.
 */
function cards(db: Db): Map<string, string> {
  const byHandle = new Map<string, string>();
  for (const c of db.all<{ handle: string; name: string }>(sql`select handle, name from contacts`)) {
    const name = c.name.trim();
    if (name === "") continue;
    const handle = c.handle.trim().toLowerCase();
    byHandle.set(handle, name);
    const number = digits(handle);
    if (number) byHandle.set(`#${number}`, name);
  }
  return byHandle;
}

function merge(db: Db, tallies: Tally[], own: ReadonlySet<string>): Person[] {
  const book = cards(db);
  const nameOf = (handle: string): string | null => {
    const direct = book.get(handle);
    if (direct) return direct;
    const number = digits(handle);
    return number ? book.get(`#${number}`) ?? null : null;
  };

  // The operator's own card gathers nobody. Their card carries their own
  // addresses and their own number, and whatever else they have filed under
  // their own name — in the real address book, a relative's address (seen
  // 2026-09-28). Merging on it would have handed that person the operator's
  // name; the handles stand on their own instead, which loses nobody.
  //
  // Their own number has to be recognised through how it is written, not as
  // a string: the address book keeps "+1 (415) 555-0100" and the texts
  // arrive from "14155550100@s.whatsapp.net", so comparing them as they
  // stand never matched and the card went on gathering (review, 2026-09-28).
  const ownNumbers = new Set<string>();
  for (const handle of own) {
    const number = digits(handle);
    if (number) ownNumbers.add(number);
  }
  const mine = new Set<string>();
  for (const [handle, name] of book) {
    const number = handle.startsWith("#") ? handle.slice(1) : digits(handle);
    if (own.has(handle) || (number && ownNumbers.has(number))) mine.add(name.toLowerCase());
  }

  /** The card a handle belongs to, unless that card is the operator's own. */
  const cardFor = (handle: string): string | null => {
    const card = nameOf(handle);
    return card && !mine.has(card.toLowerCase()) ? card : null;
  };

  const groups = new Map<string, Tally[]>();
  for (const t of tallies) {
    // One card's name gathers its handles; everyone else stands alone, under
    // their own handle, which cannot collide with a name.
    const card = cardFor(t.handle);
    const key = card ? `card:${card.toLowerCase()}` : `handle:${t.handle}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }

  const people: Person[] = [];
  for (const group of groups.values()) {
    const best = [...group].sort((a, b) => b.score - a.score);
    // The card's name is the operator's own word and beats what the mail
    // signs itself; failing that, the most recent name any message carried.
    const card = cardFor(group[0]!.handle);
    const signed = [...group].sort((a, b) => b.nameAt - a.nameAt).find((t) => t.name)?.name ?? null;
    const channels = new Set<"chat" | "mail">(group.map((t) => (isChat(t.handle) ? "chat" : "mail")));
    people.push({
      // The address they are written to at, where there is one: a link wants
      // something the operator would recognise.
      key: best.find((t) => !isChat(t.handle))?.handle ?? best[0]!.handle,
      name: card ?? signed,
      handles: group.map((t) => t.handle),
      channels: [...channels].sort(),
      lastAt: Math.max(...group.map((t) => t.lastAt)),
      count: group.reduce((sum, t) => sum + t.count, 0),
      score: group.reduce((sum, t) => sum + t.score, 0),
    });
  }
  return people.sort((a, b) => b.score - a.score || b.lastAt - a.lastAt);
}

function everyone(db: Db, at: number): Person[] {
  const cached = held.get(db as object);
  if (cached && at - cached.at < HOLD_MS) return cached.people;
  const people = gather(db, at);
  held.set(db as object, { at, people });
  return people;
}

/** The people the operator deals with most, best first. */
export function frequentPeople(db: Db, opts: { limit?: number; now?: number } = {}): Person[] {
  const at = opts.now ?? clockNow();
  const people = everyone(db, at);
  return opts.limit === undefined ? people : people.slice(0, opts.limit);
}

/** One person, by any handle they answer to. */
export function personFor(db: Db, handle: string, opts: { now?: number } = {}): Person | null {
  const key = handle.trim().toLowerCase();
  if (key === "") return null;
  const at = opts.now ?? clockNow();
  return everyone(db, at).find((p) => p.handles.includes(key)) ?? null;
}

/** What was thrown away or called junk is not part of a conversation. */
const GONE: ("trash" | "junk")[] = ["trash", "junk"];

/**
 * Every conversation this person is in, newest first, one row each: the row
 * is the newest message of the thread, whoever sent it, so a thread the
 * operator answered last reads as theirs.
 */
export function listPersonThreads(db: Db, handles: string[], opts: { limit?: number } = {}): InboxRow[] {
  const keys = handles.map((h) => h.trim().toLowerCase()).filter((h) => h !== "");
  if (keys.length === 0) return [];
  const conditions: SQL[] = [
    notInArray(messages.folder, GONE),
    // One row per conversation, and it is the newest thing still in the
    // conversation — whoever sent it, so a thread the operator answered last
    // reads as theirs rather than falling off the list.
    // Ties break on id, the way every other "newest in the thread" in this
    // codebase breaks them, so exactly one message of a thread ever matches:
    // the real mailbox holds five hundred threads with two messages sharing a
    // timestamp (review, 2026-09-28).
    sql`${messages.id} = (
      select m2.id from messages m2
      where m2.thread_id = ${messages.threadId} and m2.folder not in ('trash','junk')
      order by m2.sent_at desc, m2.id desc limit 1
    )`,
    // Anywhere in the conversation, not only in its newest message: a thread
    // is theirs from the moment they are in it.
    sql`exists (
      select 1 from messages m3 where m3.thread_id = ${messages.threadId} and (
        lower(m3.from_address) in ${keys}
        or exists (select 1 from json_each(m3.to_addresses) r where lower(r.value) in ${keys})
        or exists (select 1 from json_each(m3.cc_addresses) r where lower(r.value) in ${keys})
      )
    )`,
  ];
  return inboxRowsWhere(db, conditions, opts.limit ?? 100);
}
