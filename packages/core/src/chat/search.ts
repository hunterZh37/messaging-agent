import type { Statement } from "better-sqlite3";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { messages, type MessageRow } from "../db/schema";
import { stripQuoted } from "../text/quoted";
import { relevanceScore, type ScoreParts } from "./score";
import type { SearchHit } from "./types";

/** How much of a body goes into the index. Past this a mail is a document, not a message. */
const BODY_LIMIT = 20_000;

/**
 * Default hits handed back to the model: enough to choose from, few enough
 * to read. Exported so `meaning.ts` clamps a caller's `limit` by the same
 * default and ceiling as the keyword half (2026-10-07): two halves of one
 * search disagreeing about what `limit` means would be a bug waiting to
 * happen once `mergeHits` combines them.
 */
export const DEFAULT_LIMIT = 8;

/** The most any one search returns. "All the mail from Victoria" is a list, not a mailbox. */
export const MAX_SEARCH_LIMIT = 50;

/** What the index stores per message. `MessageRow` satisfies it; a test can pass less. */
export type IndexableMessage = Pick<MessageRow, "id" | "subject" | "fromName" | "fromAddress" | "bodyText">;

/** Writes one row, with no assumption about whether it already exists. Shared by the idempotent path below and the backfill's bulk insert. */
function insertSearchRow(stmt: Statement, message: IndexableMessage): void {
  const body = stripQuoted(message.bodyText).slice(0, BODY_LIMIT);
  stmt.run(message.id, message.subject, message.fromName ?? "", message.fromAddress, body);
}

/**
 * Puts one message in the keyword index (spec 10c). Idempotent: the old row
 * goes first, so a re-index after a body changes never leaves two copies of
 * the same message competing for the same rank.
 */
export function indexMessageForSearch(db: Db, message: IndexableMessage): void {
  db.$client.prepare("DELETE FROM messages_fts WHERE message_id = ?").run(message.id);
  insertSearchRow(db.$client.prepare("INSERT INTO messages_fts (message_id, subject, from_name, from_address, body) VALUES (?, ?, ?, ?, ?)"), message);
}

/**
 * Indexes every message that has no row yet. Runs once at boot, so mail
 * stored before the index existed is searchable, and cheap on every boot
 * after that: what is already indexed is skipped, not rewritten.
 *
 * Inserts directly rather than through `indexMessageForSearch` (2026-10-07):
 * the query above already selected only messages absent from the index, so
 * the delete half of that function's idempotency would be a guaranteed
 * no-op here, on every row — measured at 876.5 seconds for 94,242 messages,
 * almost all of it the cost of ~188,000 separate autocommitted statements.
 * One transaction around the whole pass, and one statement per row instead
 * of two, is what a boot-time rebuild needs; a message already in the index
 * never reaches this function; it keeps using the one above.
 */
export function backfillSearchIndex(db: Db): number {
  const rows = db
    .select({ id: messages.id, subject: messages.subject, fromName: messages.fromName, fromAddress: messages.fromAddress, bodyText: messages.bodyText })
    .from(messages)
    .where(sql`${messages.id} NOT IN (SELECT message_id FROM messages_fts)`)
    .all();
  const insert = db.$client.prepare("INSERT INTO messages_fts (message_id, subject, from_name, from_address, body) VALUES (?, ?, ?, ?, ?)");
  db.$client.transaction(() => {
    for (const row of rows) insertSearchRow(insert, row);
  })();
  return rows.length;
}

/**
 * Drops a keyword index built before stemming, so the boot that follows
 * refills it (2026-10-07). `CREATE VIRTUAL TABLE IF NOT EXISTS` cannot change
 * the tokenizer of a table that already exists, and an index half stemmed
 * would answer differently depending on when a message happened to arrive.
 * Refilling 94,242 messages was measured at about 1.0 second, so this costs
 * one slow boot, once — but only because `backfillSearchIndex` below wraps
 * the refill in one transaction (2026-10-07): the first shipped version did
 * not, and the same refill measured 876.5 seconds against the operator's own
 * mailbox before that fix, ~188,000 separate autocommitted statements
 * instead of one.
 */
export function rebuildSearchIndexIfStale(db: Db): boolean {
  const row = db.$client
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages_fts'")
    .get() as { sql: string } | undefined;
  if (!row || row.sql.includes("tokenize='porter")) return false;
  // `celeste run` opens this same file in another connection and indexes as
  // it syncs, with no try/catch (apps/cli/src/main.ts). Drop and create as
  // one transaction, not two autocommit statements, so that connection never
  // sees a window with no `messages_fts` table to insert into (2026-10-07).
  db.$client.transaction(() => {
    db.$client.exec("DROP TABLE messages_fts");
    db.$client.exec(
      "CREATE VIRTUAL TABLE messages_fts USING fts5(message_id UNINDEXED, subject, from_name, from_address, body, tokenize='porter unicode61')",
    );
  })();
  return true;
}

/**
 * The operator's words are not FTS5 syntax. Every run of letters and digits
 * becomes one quoted term, so a colon, a quote, or a stray `NEAR` is content
 * rather than an operator that throws.
 */
export function ftsQuery(query: string, join: "AND" | "OR"): string | null {
  const terms = query.match(/[\p{L}\p{N}_]+/gu);
  if (!terms || terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(` ${join} `);
}

/** The same split `ftsQuery` makes, just counted rather than joined. */
function wordCount(query: string): number {
  return (query.match(/[\p{L}\p{N}_]+/gu) ?? []).length;
}

export interface SearchRow {
  message_id: string;
  thread_id: string;
  subject: string;
  from_name: string | null;
  from_address: string;
  sent_at: number;
  snippet: string;
  provider: string;
  folder: string;
  /** Only on a row that came from the index: `bm25()`, negative and better the lower it goes. */
  bm25?: number;
}

/** Where a message came from, as Celeste says it (2026-09-11: texts and WhatsApp are searchable too). */
export type Channel = "mail" | "imessage" | "whatsapp";

export function channelOf(provider: string): Channel {
  return provider === "imessage" ? "imessage" : provider === "whatsapp" ? "whatsapp" : "mail";
}

/** What narrows a search besides the words: who it is from, and where it is filed. */
export interface SearchFilters {
  accountId?: string;
  limit?: number;
  /** Case-insensitive substring of the sender's name or address. */
  from?: string;
  /** A project id; the caller resolves the operator's name for it. */
  projectId?: string;
  /** Only mail, only Messages chats, or only WhatsApp chats. */
  channel?: Channel;
}

/**
 * The conditions every shape of the query shares, and the join a project
 * filter needs. Exported so `meaning.ts` narrows a vector hit by the same
 * rules a keyword hit is narrowed by (2026-10-07): one inbox, one sender, one
 * project means the same thing on both halves of search.
 */
export function narrow(filters: SearchFilters): { join: string; where: string[]; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  let join = "";
  if (filters.accountId) {
    // The selected inbox narrows mail. Chats belong to no inbox, and the
    // Messages folder ignores the switcher the same way (2026-09-14: asked
    // about Keith's WhatsApp texts with a Gmail selected, Celeste found no
    // chat by that name because the chat was outside the inbox).
    where.push("(m.account_id = ? OR a.provider IN ('imessage', 'whatsapp'))");
    params.push(filters.accountId);
  }
  if (filters.from) {
    // One name for both halves of a sender: "victoria" finds her whether the
    // mail carries her name or only her address.
    where.push("(lower(coalesce(m.from_name, '')) LIKE ? OR lower(m.from_address) LIKE ?)");
    const like = `%${filters.from.trim().toLowerCase()}%`;
    params.push(like, like);
  }
  if (filters.projectId) {
    join = " JOIN project_assignments pa ON pa.message_id = m.id AND pa.project_id = ?";
  }
  if (filters.channel === "mail") where.push("a.provider NOT IN ('imessage', 'whatsapp')");
  else if (filters.channel) {
    where.push("a.provider = ?");
    params.push(filters.channel);
  }
  return { join, where, params };
}

/** Exported so `meaning.ts` selects the same columns a keyword hit is built from (2026-10-07). */
export const COLUMNS = `m.id AS message_id, m.thread_id AS thread_id, m.subject AS subject, m.from_name AS from_name,
                 m.from_address AS from_address, m.sent_at AS sent_at, a.provider AS provider, m.folder AS folder`;
/** Exported alongside `COLUMNS` for the same reason (2026-10-07). */
export const ACCOUNT = " JOIN accounts a ON a.id = m.account_id";

/**
 * Exported so a meaning hit is built by this and only this function
 * (2026-10-07): two code paths constructing a `SearchHit` would drift the
 * moment one of them changed.
 */
export function toHits(rows: SearchRow[], terms: string[] = [], now: number = Date.now()): SearchHit[] {
  return rows.map((r) => {
    const channel = channelOf(r.provider);
    // Only a row the index ranked carries a bm25, and only those get the parts
    // a score is built from (spec 2026-10-07). A filters-only result was never
    // ranked against anything, so there is nothing to say about how well it
    // matched — the card simply shows no score.
    const subject = r.subject?.toLowerCase() ?? "";
    // What the operator can be told was found: the terms this row actually
    // shows. The snippet is the matched line, so between it and the subject
    // this is what a reader would see for themselves (whole-branch review,
    // 2026-10-07 — reciting the whole query was a lie under the OR fallback,
    // where a hit needs only one of its terms).
    const seen = `${subject} ${r.snippet?.toLowerCase() ?? ""}`;
    const matched = terms.filter((t) => seen.includes(t.toLowerCase()));
    const parts =
      r.bm25 === undefined
        ? undefined
        : {
            // Per term: bm25 is a sum over the query's words, so the raw figure
            // grows with how many were asked and a four-word question clamped
            // every result to 100.
            words: r.bm25 / Math.max(1, terms.length),
            ageMs: Math.max(0, now - r.sent_at),
            inSubject: terms.some((t) => subject.includes(t.toLowerCase())),
            ...(matched.length > 0 ? { matched } : {}),
          };
    return {
      messageId: r.message_id,
      threadId: r.thread_id,
      // A chat is named after the person or group; the subject says so.
      subject: channel === "mail" ? r.subject : `${channel === "whatsapp" ? "WhatsApp" : "Messages"} chat: ${r.subject}`,
      from: r.from_name ? `${r.from_name} <${r.from_address}>` : r.from_address,
      sentAt: r.sent_at,
      snippet: r.snippet,
      channel,
      ...(r.folder === "trash" ? { deleted: true } : {}),
      ...(parts ? { parts } : {}),
    };
  });
}

/** Words plus filters: the index decides the order, best match first. */
function runMatch(db: Db, match: string, filters: SearchFilters, limit: number, terms: string[]): SearchHit[] {
  const { join, where, params } = narrow(filters);
  // The project id binds in the join, ahead of every other parameter.
  const bound: (string | number)[] = [...(filters.projectId ? [filters.projectId] : []), match, ...params, limit];
  const rows = db.$client
    .prepare(
      `SELECT ${COLUMNS}, snippet(messages_fts, 4, '', '', '…', 14) AS snippet, bm25(messages_fts) AS bm25
       FROM messages_fts f JOIN messages m ON m.id = f.message_id${ACCOUNT}${join}
       WHERE messages_fts MATCH ?${where.length > 0 ? ` AND ${where.join(" AND ")}` : ""}
       ORDER BY rank LIMIT ?`,
    )
    .all(...bound) as SearchRow[];
  return toHits(rows, terms);
}

/** Filters with no words: there is no rank to sort by, so the newest come first. */
function runFilters(db: Db, filters: SearchFilters, limit: number): SearchHit[] {
  const { join, where, params } = narrow(filters);
  if (where.length === 0 && !filters.projectId) return [];
  const bound: (string | number)[] = [...(filters.projectId ? [filters.projectId] : []), ...params, limit];
  const rows = db.$client
    .prepare(
      `SELECT ${COLUMNS}, substr(replace(m.body_text, char(10), ' '), 1, 160) AS snippet
       FROM messages m${ACCOUNT}${join}
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY m.sent_at DESC LIMIT ?`,
    )
    .all(...bound) as SearchRow[];
  return toHits(rows);
}

/**
 * Terms an OR fallback can still trust as "the operator's words were in
 * this message" rather than "this message happens to share one word with
 * the question" (2026-10-07). A query of a few real terms is still mostly
 * content when matched on any one of them — "invoice acme march" missing
 * "acme" is still about an invoice. A sentence has function words in it
 * too, and OR's "any one of these" then just as happily matches on "the"
 * or "what" as on the one word that mattered.
 */
const OR_FALLBACK_MAX_TERMS = 3;

/**
 * Keyword search over subject, sender and body (spec 10c), the tool behind
 * "search the whole inbox". Every term has to appear; when nothing matches
 * all of them the same terms are tried as alternatives, because half an
 * answer beats none. `from` and `projectId` narrow whatever the words find,
 * and stand on their own when there are no words: "everything from Victoria"
 * is a question about a sender, not about a subject. Bad syntax never
 * throws — it comes back empty.
 *
 * `fallback` is "always" by default: the OR fallback above ran for any
 * query, which was the whole of "half an answer beats none" when the words
 * were the only half there was. `"short-only"` is what `searchHybrid` asks
 * for once the meaning half has actually answered a question (2026-10-07):
 * the fallback's job changed the day a second half arrived able to answer
 * a sentence-shaped question on its own, so a query longer than
 * `OR_FALLBACK_MAX_TERMS` terms no longer OR-falls-back at all rather than
 * matching on whichever of its words happens to be commonest in the
 * mailbox. A short query — still mostly content words either way — falls
 * back exactly as it always has.
 */
export function searchMessages(db: Db, query: string, opts: SearchFilters = {}, fallback: "always" | "short-only" = "always"): SearchHit[] {
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_SEARCH_LIMIT);
  try {
    // The operator's own words, which `toHits` needs to say whether they were
    // in the subject — the one part of the score's reason that cannot be read
    // off the index (2026-10-07).
    const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    const all = ftsQuery(query, "AND");
    if (!all) return runFilters(db, opts, limit);
    const hits = runMatch(db, all, opts, limit, terms);
    if (hits.length > 0) return hits;
    if (fallback === "short-only" && wordCount(query) > OR_FALLBACK_MAX_TERMS) return [];
    const any = ftsQuery(query, "OR");
    return any ? runMatch(db, any, opts, limit, terms) : [];
  } catch {
    // A query the index refuses is a miss, not a crash: the model asked
    // something, and "nothing found" is an answer it can work with.
    return [];
  }
}

/**
 * The two halves of a search, as one list (2026-10-07). They answer different
 * questions well: the words find `IOE8022910507`, which is in 71 of the
 * operator's messages and which an embedding model turns to noise, and the
 * meaning finds the mail about billing when the question said invoicing.
 *
 * So they alternate, words first. Whatever the keyword index thought was the
 * best match stays the first thing the operator sees, and a meaning match
 * reaches the list without having to beat it. A message both halves found is
 * one message, at the better of its two places.
 *
 * This is also the only place that marks each hit's `match` (2026-10-07):
 * the meaning half has no distance floor, so with no cue a question whose
 * words matched nothing hands Celeste up to a limit's worth of merely
 * nearest-anything mail, indistinguishable from an exact hit — the same
 * reasoning `searchByMeaning` already applies to a wordless query, extended
 * to a query whose words simply miss. Only here are both halves' id sets
 * in hand at once to tell "words", "meaning" and "both" apart, so every
 * caller is expected to route every hit through this — a words-only or
 * meaning-only result included, with the other half passed as `[]`.
 */
export function mergeHits(words: SearchHit[], meaning: SearchHit[], limit: number): SearchHit[] {
  const wordIds = new Set(words.map((h) => h.messageId));
  const meaningIds = new Set(meaning.map((h) => h.messageId));
  const matchFor = (id: string): SearchHit["match"] => (wordIds.has(id) && meaningIds.has(id) ? "both" : meaningIds.has(id) ? "meaning" : "words");
  // What each half said about a message, so a message both of them found can
  // be scored on the evidence of both (spec 2026-10-07). Built from the full
  // lists, before the limit truncates either of them.
  const byWords = new Map(words.map((h) => [h.messageId, h]));
  const byMeaning = new Map(meaning.map((h) => [h.messageId, h]));

  const out: SearchHit[] = [];
  const seen = new Set<string>();
  for (let i = 0; out.length < limit && (i < words.length || i < meaning.length); i++) {
    for (const hit of [words[i], meaning[i]]) {
      if (!hit || seen.has(hit.messageId) || out.length >= limit) continue;
      seen.add(hit.messageId);
      out.push(scored(hit, matchFor(hit.messageId), byWords.get(hit.messageId), byMeaning.get(hit.messageId)));
    }
  }
  return out;
}

/**
 * One hit with its score, from whatever the two halves each knew about it. A
 * hit neither half ranked — which cannot come from a search, but keeps this
 * total — gets its match and no score: the panel then draws the card without
 * a score rail rather than showing a number nothing stands behind.
 */
function scored(hit: SearchHit, match: SearchHit["match"], fromWords: SearchHit | undefined, fromMeaning: SearchHit | undefined): SearchHit {
  const w = fromWords?.parts;
  const m = fromMeaning?.parts;
  if (!w && !m) return { ...hit, match };
  // Whichever half saw the operator's terms is the one that can name them, so
  // they are carried rather than rebuilt — dropping them here left the reason
  // saying "your words" for a hit that knew exactly which ones (2026-10-07).
  const matched = w?.matched ?? m?.matched;
  const parts: ScoreParts = {
    ...(w?.words !== undefined ? { words: w.words } : {}),
    ...(m?.meaning !== undefined ? { meaning: m.meaning } : {}),
    ageMs: w?.ageMs ?? m?.ageMs ?? 0,
    inSubject: Boolean(w?.inSubject || m?.inSubject),
    ...(matched && matched.length > 0 ? { matched } : {}),
  };
  return { ...hit, match, parts, score: relevanceScore(parts) };
}
