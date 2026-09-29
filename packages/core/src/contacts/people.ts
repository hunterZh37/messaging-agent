import { inArray, notInArray, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import { now as clockNow } from "../db/client";
import { accounts, messages, peopleBumps } from "../db/schema";
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
export { SIDEBAR_PEOPLE, PEOPLE_CHOICES, PEOPLE_MAX } from "./limits";

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
  /**
   * The inboxes this person was seen in, busiest first, by the address each
   * one is named by — "hunter@…" for mail, "whatsapp:…" or "messages:…" for
   * the two chat accounts. The rail says the first beside their name, because
   * the same name
   * turning up twice reads as a fault until you can see that one of them is
   * WhatsApp and the other is a work address (operator, 2026-09-29: "do not
   * merge but display if the contact is from email (which inbox) or whatsapp
   * or message").
   */
  from: string[];
  /** The last time anything passed between them and the operator. */
  lastAt: number;
  /** How many messages that is, all time. */
  count: number;
  /** What those messages are worth today, newer ones worth more. */
  score: number;
  /**
   * Put aside by the operator and quiet since. They keep their page and every
   * conversation on it; they are simply not among the people the sidebar
   * offers, until they write again (2026-09-28).
   */
  putAside: boolean;
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
  /** When the operator last put this handle aside, or null. */
  bumped: number | null;
  /** The newest thing said since they were put aside, 0 if nothing. */
  since: number;
  /** The accounts this handle was seen in, and how much of it was in each. */
  accounts: Map<string, number>;
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

  // What the operator has said they are done with, and when. Everything said
  // before that moment stops counting, so the person drops off the list and
  // climbs back only on what they send next (2026-09-28).
  const bumped = new Map<string, number>();
  for (const b of db.select().from(peopleBumps).all()) bumped.set(b.handle, b.at);

  const byHandle = new Map<string, Tally>();
  const add = (handle: string, name: string | null, sentAt: number, accountId: string | null) => {
    const key = handle.trim().toLowerCase();
    if (key === "" || own.has(key)) return;
    if (NOT_A_PERSON.some((suffix) => key.endsWith(suffix))) return;
    if (AUTOMATED.test(key)) return;
    const row = byHandle.get(key) ?? { handle: key, name: null, nameAt: -1, lastAt: 0, count: 0, score: 0, bumped: bumped.get(key) ?? null, since: 0, accounts: new Map<string, number>() };
    row.count += 1;
    // Everything said before the operator put this person aside stops counting
    // towards how much they deal with them. The person themselves stays: their
    // page is a link somebody may already have open, and putting them aside
    // was never meant to lose the conversation (own test, 2026-09-28).
    if (row.bumped === null || sentAt > row.bumped) {
      row.score += weight(sentAt, at);
      if (sentAt > row.since) row.since = sentAt;
    }
    if (sentAt > row.lastAt) row.lastAt = sentAt;
    if (accountId) row.accounts.set(accountId, (row.accounts.get(accountId) ?? 0) + 1);
    if (name?.trim() && sentAt >= row.nameAt) {
      row.name = name.trim();
      row.nameAt = sentAt;
    }
    byHandle.set(key, row);
  };

  for (const m of db.all<{ handle: string; name: string | null; sentAt: number; accountId: string }>(sql`
    select lower(from_address) as handle, from_name as name, sent_at as sentAt, account_id as accountId from messages
  `)) {
    add(m.handle, m.name, m.sentAt, m.accountId);
  }
  // Who the operator wrote to. Only their own mail is read this way: every
  // message they *receive* carries their own address in `to`, along with
  // whoever else was copied in, so counting those made the operator's own
  // aliases the people they dealt with most and promoted anyone who happened
  // to be cc'd (seen against the real mailbox, 2026-09-28). Someone the
  // operator has written to, or heard from, is someone they talk to; a name
  // in the copy line of somebody else's mail is not.
  for (const m of db.all<{ handle: string; sentAt: number; accountId: string }>(sql`
    select lower(r.value) as handle, m.sent_at as sentAt, m.account_id as accountId from messages m, json_each(m.to_addresses) r where m.is_from_operator = 1
    union all
    select lower(r.value) as handle, m.sent_at as sentAt, m.account_id as accountId from messages m, json_each(m.cc_addresses) r where m.is_from_operator = 1
  `)) {
    add(m.handle, null, m.sentAt, m.accountId);
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

/**
 * The inboxes a person was reached in, the busiest first: the rail has room
 * for one of them beside a name, and the one most of them came through is the
 * one worth the room (2026-09-29).
 */
function from(group: Tally[], inbox: ReadonlyMap<string, string>): string[] {
  const byAccount = new Map<string, number>();
  for (const t of group) {
    for (const [id, n] of t.accounts) byAccount.set(id, (byAccount.get(id) ?? 0) + n);
  }
  return [...byAccount.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id]) => inbox.get(id))
    .filter((email): email is string => Boolean(email));
}

/**
 * Whether this person is one the operator has put aside and who has said
 * nothing since. The moment is the latest any of their handles carries, and
 * nothing said at or before it counts — including anything on a handle that
 * was never itself pressed (review, 2026-09-28).
 */
function putAside(group: Tally[]): boolean {
  const moments = group.map((t) => t.bumped).filter((b): b is number => b !== null);
  if (moments.length === 0) return false;
  const at = Math.max(...moments);
  return group.every((t) => t.lastAt <= at);
}

function merge(db: Db, tallies: Tally[], own: ReadonlySet<string>): Person[] {
  const book = cards(db);
  // Each inbox by the address it is named by: "hunter@…" for mail, and the
  // "whatsapp:" / "messages:" names the two chat accounts carry.
  const inbox = new Map(db.select({ id: accounts.id, email: accounts.email }).from(accounts).all().map((a) => [a.id, a.email]));
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
      // In the order the inboxes are listed, so the rail reads the same way
      // twice running.
      from: from(group, inbox),
      // Put aside is asked of the person, not of each handle they answer to:
      // once the operator says they are done, a handle that joins them later
      // (an address book edit merges one in) must not bring their whole
      // history back with it (review, 2026-09-28). The latest moment any of
      // their handles was put aside stands for all of them.
      putAside: putAside(group),
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

/**
 * Done with this person, for now (operator, 2026-09-28: "should have the
 * ability to delete someone off"). Every handle they answer to is marked with
 * the moment, so a merged person goes as one; what they send after it counts
 * as it always did, which is how they come back without being asked.
 *
 * Their mail is not touched. This is a row in a sidebar, not a blocklist.
 */
export function bumpPerson(db: Db, handles: string[], at: number = clockNow()): void {
  const keys = [...new Set(handles.map((h) => h.trim().toLowerCase()).filter((h) => h !== ""))];
  if (keys.length === 0) return;
  // A person goes as one: every handle in the same transaction, so a failure
  // halfway cannot leave them half put aside (review, 2026-09-28).
  db.transaction((tx) => {
    for (const handle of keys) {
      tx.insert(peopleBumps)
        .values({ handle, at })
        .onConflictDoUpdate({ target: peopleBumps.handle, set: { at } })
        .run();
    }
  });
  forgetPeople(db);
}

/** Undo: the person stands exactly where they stood before (2026-09-28). */
export function unbumpPerson(db: Db, handles: string[]): void {
  const keys = handles.map((h) => h.trim().toLowerCase()).filter((h) => h !== "");
  if (keys.length === 0) return;
  db.delete(peopleBumps).where(inArray(peopleBumps.handle, keys)).run();
  forgetPeople(db);
}


/** The people the operator deals with most, best first. */
export function frequentPeople(db: Db, opts: { limit?: number; now?: number } = {}): Person[] {
  const at = opts.now ?? clockNow();
  // Everyone the operator has not put aside. The rest are still gathered, and
  // `personFor` still finds them: putting someone aside takes them off a list,
  // it does not take away the way back to what was said.
  const people = everyone(db, at).filter((p) => !p.putAside);
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
