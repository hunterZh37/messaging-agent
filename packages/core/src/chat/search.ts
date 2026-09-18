import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { messages, type MessageRow } from "../db/schema";
import { stripQuoted } from "../text/quoted";
import type { SearchHit } from "./types";

/** How much of a body goes into the index. Past this a mail is a document, not a message. */
const BODY_LIMIT = 20_000;

/** Default hits handed back to the model: enough to choose from, few enough to read. */
const DEFAULT_LIMIT = 8;

/** The most any one search returns. "All the mail from Victoria" is a list, not a mailbox. */
export const MAX_SEARCH_LIMIT = 50;

/** What the index stores per message. `MessageRow` satisfies it; a test can pass less. */
export type IndexableMessage = Pick<MessageRow, "id" | "subject" | "fromName" | "fromAddress" | "bodyText">;

/**
 * Puts one message in the keyword index (spec 10c). Idempotent: the old row
 * goes first, so a re-index after a body changes never leaves two copies of
 * the same message competing for the same rank.
 */
export function indexMessageForSearch(db: Db, message: IndexableMessage): void {
  const body = stripQuoted(message.bodyText).slice(0, BODY_LIMIT);
  db.$client.prepare("DELETE FROM messages_fts WHERE message_id = ?").run(message.id);
  db.$client
    .prepare("INSERT INTO messages_fts (message_id, subject, from_name, from_address, body) VALUES (?, ?, ?, ?, ?)")
    .run(message.id, message.subject, message.fromName ?? "", message.fromAddress, body);
}

/**
 * Indexes every message that has no row yet. Runs once at boot, so mail
 * stored before the index existed is searchable, and cheap on every boot
 * after that: what is already indexed is skipped, not rewritten.
 */
export function backfillSearchIndex(db: Db): number {
  const rows = db
    .select({ id: messages.id, subject: messages.subject, fromName: messages.fromName, fromAddress: messages.fromAddress, bodyText: messages.bodyText })
    .from(messages)
    .where(sql`${messages.id} NOT IN (SELECT message_id FROM messages_fts)`)
    .all();
  for (const row of rows) indexMessageForSearch(db, row);
  return rows.length;
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

interface SearchRow {
  message_id: string;
  thread_id: string;
  subject: string;
  from_name: string | null;
  from_address: string;
  sent_at: number;
  snippet: string;
  provider: string;
  folder: string;
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

/** The conditions every shape of the query shares, and the join a project filter needs. */
function narrow(filters: SearchFilters): { join: string; where: string[]; params: (string | number)[] } {
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

const COLUMNS = `m.id AS message_id, m.thread_id AS thread_id, m.subject AS subject, m.from_name AS from_name,
                 m.from_address AS from_address, m.sent_at AS sent_at, a.provider AS provider, m.folder AS folder`;
const ACCOUNT = " JOIN accounts a ON a.id = m.account_id";

function toHits(rows: SearchRow[]): SearchHit[] {
  return rows.map((r) => {
    const channel = channelOf(r.provider);
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
    };
  });
}

/** Words plus filters: the index decides the order, best match first. */
function runMatch(db: Db, match: string, filters: SearchFilters, limit: number): SearchHit[] {
  const { join, where, params } = narrow(filters);
  // The project id binds in the join, ahead of every other parameter.
  const bound: (string | number)[] = [...(filters.projectId ? [filters.projectId] : []), match, ...params, limit];
  const rows = db.$client
    .prepare(
      `SELECT ${COLUMNS}, snippet(messages_fts, 4, '', '', '…', 14) AS snippet
       FROM messages_fts f JOIN messages m ON m.id = f.message_id${ACCOUNT}${join}
       WHERE messages_fts MATCH ?${where.length > 0 ? ` AND ${where.join(" AND ")}` : ""}
       ORDER BY rank LIMIT ?`,
    )
    .all(...bound) as SearchRow[];
  return toHits(rows);
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
 * Keyword search over subject, sender and body (spec 10c), the tool behind
 * "search the whole inbox". Every term has to appear; when nothing matches
 * all of them the same terms are tried as alternatives, because half an
 * answer beats none. `from` and `projectId` narrow whatever the words find,
 * and stand on their own when there are no words: "everything from Victoria"
 * is a question about a sender, not about a subject. Bad syntax never
 * throws — it comes back empty.
 */
export function searchMessages(db: Db, query: string, opts: SearchFilters = {}): SearchHit[] {
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_SEARCH_LIMIT);
  try {
    const all = ftsQuery(query, "AND");
    if (!all) return runFilters(db, opts, limit);
    const hits = runMatch(db, all, opts, limit);
    if (hits.length > 0) return hits;
    const any = ftsQuery(query, "OR");
    return any ? runMatch(db, any, opts, limit) : [];
  } catch {
    // A query the index refuses is a miss, not a crash: the model asked
    // something, and "nothing found" is an answer it can work with.
    return [];
  }
}
