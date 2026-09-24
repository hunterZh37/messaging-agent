import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { now } from "../db/client";
import { accounts } from "../db/schema";

/**
 * Who the operator could be writing to, from everyone they have mailed or
 * heard from (operator, 2026-09-23: "if I type in the first half of a contact
 * name or email address, it should give me autofill capabilities based on all
 * the contacts that we have emails or messages from and to").
 *
 * Read out of the mail rather than kept in a table of its own: a table would
 * be one more thing to keep true, and the whole sweep over 90,000 messages
 * takes about a fifth of a second. That is too slow for a keystroke, so the
 * list is built once and held for a minute; the answer to what someone is
 * typing is then found in memory.
 *
 * Every inbox counts, because a person is a person whichever of them they
 * wrote to; the account being sent from ranks first. The address book joins in
 * only where it holds an email: compose sends mail, and a phone number is not
 * something a mail can reach.
 */

export interface RecipientSuggestion {
  address: string;
  /** Their name where the mail or the address book carries one. */
  name: string | null;
  /** The last time anything passed between them and the operator, 0 if never. */
  lastAt: number;
  /** How many messages that is, which is roughly how well they are known. */
  count: number;
  /** Seen on the account being written from. Filled in per query. */
  onThisAccount: boolean;
}

interface Row {
  address: string;
  name: string | null;
  /** When that name was used: an older mail that carries one still beats none. */
  nameAt: number;
  lastAt: number;
  count: number;
  accounts: Set<string>;
}

const HOLD_MS = 60_000;
const cache = new WeakMap<object, { at: number; rows: Row[] }>();

/**
 * WhatsApp's own identities carry an @ and are not addresses anybody can
 * write to: `<id>@lid`, `<number>@s.whatsapp.net`, a group's `<id>@g.us`.
 * They reached the list because an @ was taken to mean an email (found in the
 * browser, 2026-09-23: "Kate Czarniak | 176231148437518@lid").
 */
const CHAT_DOMAINS = ["@lid", "@s.whatsapp.net", "@g.us", "@broadcast", "@newsletter"];

function looksLikeEmail(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (CHAT_DOMAINS.some((domain) => v.endsWith(domain))) return false;
  // A real address has a dot in its domain: an @lid or a bare handle has not.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

/** Everyone, built from the mail and the address book. Held for a minute. */
function everyone(db: Db, clock: () => number = now): Row[] {
  const held = cache.get(db as object);
  if (held && clock() - held.at < HOLD_MS) return held.rows;

  // The operator's own addresses are not people they write to: they are who
  // the mail comes from, and they are already in the From picker.
  const own = new Set(
    db.select({ email: accounts.email }).from(accounts).all().map((a) => a.email.trim().toLowerCase()),
  );

  const byAddress = new Map<string, Row>();
  const add = (address: string, name: string | null, sentAt: number, accountId: string | null) => {
    const key = address.trim().toLowerCase();
    if (!looksLikeEmail(key) || own.has(key)) return;
    const row = byAddress.get(key) ?? { address: key, name: null, nameAt: -1, lastAt: 0, count: 0, accounts: new Set<string>() };
    row.count += 1;
    if (sentAt > row.lastAt) row.lastAt = sentAt;
    // The most recent name wins, and any name beats none: people change how
    // they sign themselves, and plenty of mail carries no name at all.
    if (name?.trim() && sentAt >= row.nameAt) {
      row.name = name.trim();
      row.nameAt = sentAt;
    }
    if (accountId) row.accounts.add(accountId);
    byAddress.set(key, row);
  };

  for (const m of db.all<{ address: string; name: string | null; sentAt: number; accountId: string }>(sql`
    select lower(from_address) as address, from_name as name, sent_at as sentAt, account_id as accountId
    from messages where from_address like '%@%'
  `)) {
    add(m.address, m.name, m.sentAt, m.accountId);
  }
  for (const m of db.all<{ address: string; sentAt: number; accountId: string }>(sql`
    select lower(r.value) as address, m.sent_at as sentAt, m.account_id as accountId
    from messages m, json_each(m.to_addresses) r where r.value like '%@%'
    union all
    select lower(r.value) as address, m.sent_at as sentAt, m.account_id as accountId
    from messages m, json_each(m.cc_addresses) r where r.value like '%@%'
  `)) {
    add(m.address, null, m.sentAt, m.accountId);
  }
  // Someone whose mail the operator has never had, but whose address Contacts
  // knows. Never overwrites what the mail itself says about them.
  for (const c of db.all<{ handle: string; name: string }>(sql`select handle, name from contacts where handle like '%@%'`)) {
    const key = c.handle.trim().toLowerCase();
    if (!looksLikeEmail(key) || own.has(key)) continue;
    const row = byAddress.get(key);
    if (row) {
      row.name ??= c.name.trim() || null;
    } else {
      // A name is what the address book usually adds, not what makes an
      // address worth offering (review, 2026-09-23): an entry with an email
      // and no name is still somewhere the operator can write.
      byAddress.set(key, { address: key, name: c.name.trim() || null, nameAt: 0, lastAt: 0, count: 0, accounts: new Set() });
    }
  }

  const rows = [...byAddress.values()];
  cache.set(db as object, { at: clock(), rows });
  return rows;
}

/** Forget the held list: for a test, or after a sync brings new people in. */
export function forgetRecipients(db: Db): void {
  cache.delete(db as object);
}

/**
 * Everyone matching `query`, best first. An empty query answers with the
 * people most recently in touch, which is what an empty field should offer.
 */
export function suggestRecipients(
  db: Db,
  opts: { query?: string; accountId?: string; limit?: number; clock?: () => number } = {},
): RecipientSuggestion[] {
  const q = (opts.query ?? "").trim().toLowerCase();
  const limit = opts.limit ?? 8;
  const rows = everyone(db, opts.clock);
  const matched: RecipientSuggestion[] = [];
  for (const row of rows) {
    const name = (row.name ?? "").toLowerCase();
    if (q !== "" && !row.address.includes(q) && !name.includes(q)) continue;
    matched.push({
      address: row.address,
      name: row.name,
      lastAt: row.lastAt,
      count: row.count,
      onThisAccount: opts.accountId ? row.accounts.has(opts.accountId) : false,
    });
  }
  const at = opts.clock?.() ?? now();
  return matched
    .sort((a, b) => rank(b, q, at) - rank(a, q, at) || a.address.localeCompare(b.address))
    .slice(0, limit);
}

/**
 * Addresses nobody writes back to. They are kept, because the operator may
 * want one, but they sink: typing "hunter" used to offer a notification
 * sender whose display name happened to carry the word (found in the browser,
 * 2026-09-23).
 */
const AUTOMATED = /^(no[-._]?reply|donotreply|do[-._]?not[-._]?reply|notifications?|mailer[-._]?daemon|bounces?|postmaster|support|info|admin)[@+.]/;

/**
 * How well one person answers what was typed.
 *
 * The address counts for more than the name: someone typing "hunter" means an
 * address that begins that way, not everyone whose display name carries the
 * word. Then whether they start with it at all, then the account being written
 * from, then how recently and how often they have been in touch.
 */
function rank(s: RecipientSuggestion, q: string, at: number): number {
  const name = (s.name ?? "").toLowerCase();
  const local = s.address.split("@")[0] ?? "";
  const addressStarts = q !== "" && s.address.startsWith(q);
  const nameStarts = q !== "" && (name.startsWith(q) || name.split(/\s+/).some((word) => word.startsWith(q)));
  const addressHolds = q !== "" && local.includes(q);
  const months = s.lastAt === 0 ? 999 : Math.floor((at - s.lastAt) / (1000 * 60 * 60 * 24 * 30));
  const recency = Math.max(0, 24 - months);
  const automated = AUTOMATED.test(s.address) ? -5_000 : 0;
  return (
    (addressStarts ? 40_000 : 0) +
    (nameStarts ? 20_000 : 0) +
    (addressHolds ? 10_000 : 0) +
    (s.onThisAccount ? 1_000 : 0) +
    recency * 10 +
    Math.min(s.count, 50) +
    automated
  );
}
