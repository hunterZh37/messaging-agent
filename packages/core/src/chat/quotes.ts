import { inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { messages } from "../db/schema";

/**
 * Quotes Celeste puts in an answer, checked against the messages they cite
 * (operator, 2026-09-15: "celeste gave me a wrong answer"). Asked for a
 * password from a WhatsApp chat, she answered from earlier in the
 * conversation and "quoted" a line no message holds: one account's address
 * with another account's password, cited to the wrong message. Nothing looked
 * at the quote, so an invented one read as true as a real one.
 *
 * A quote is a blockquote line (`> …`) or text in double quotes, eight
 * characters or more, with a `[msg:<id>]` citation on the same line or the
 * line after. Its pieces, split where she joins or elides (" / ", "…", "..."),
 * must each appear in the cited message, case, spacing and quote marks aside.
 */
export interface QuoteMismatch {
  quote: string;
  messageId: string;
}

const CITE = /\[msg:([^\]\s]+)\]/g;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The quoted spans in one line of an answer. */
function quotesIn(line: string): string[] {
  const out: string[] = [];
  const bare = line.replace(CITE, "").trim();
  if (/^>\s*/.test(bare)) out.push(bare.replace(/^>\s*/, ""));
  else for (const m of bare.matchAll(/["“]([^"“”]{8,})["”]/g)) out.push(m[1]!);
  return out.map((q) => q.replace(/^["“]|["”]$/g, "").trim()).filter((q) => q.length >= 8);
}

/** The pieces a quote must contain, where she has joined lines or left words out. */
export function quotePieces(quote: string): string[] {
  return quote
    .split(/\s+\/\s+|…|\.\.\./)
    .map((p) => normalize(p).replace(/^[\s"'.,;:]+|[\s"'.,;:]+$/g, ""))
    .filter((p) => p.length >= 4);
}

/** Every quote that cites a message it is not in. */
export function findQuoteMismatches(answer: string, bodyOf: (messageId: string) => string | null): QuoteMismatch[] {
  const lines = answer.split("\n");
  const out: QuoteMismatch[] = [];
  lines.forEach((line, i) => {
    const quotes = quotesIn(line);
    if (quotes.length === 0) return;
    const cites = [...line.matchAll(CITE), ...(lines[i + 1] ?? "").matchAll(CITE)].map((m) => m[1]!);
    if (cites.length === 0) return;
    for (const quote of quotes) {
      const pieces = quotePieces(quote);
      if (pieces.length === 0) continue;
      const found = cites.some((id) => {
        const body = bodyOf(id);
        if (body === null) return false;
        const hay = normalize(body);
        return pieces.every((p) => hay.includes(p));
      });
      if (!found) out.push({ quote, messageId: cites[0]! });
    }
  });
  return out;
}

/** The same check over the database: a cited id is looked up once, subject and body both searchable. */
export function checkQuotes(db: Db, answer: string): QuoteMismatch[] {
  const ids = [...new Set([...answer.matchAll(CITE)].map((m) => m[1]!))];
  if (ids.length === 0) return [];
  const rows = db.select({ id: messages.id, subject: messages.subject, bodyText: messages.bodyText }).from(messages).where(inArray(messages.id, ids)).all();
  const bodies = new Map(rows.map((r) => [r.id, `${r.subject}\n${r.bodyText}`]));
  return findQuoteMismatches(answer, (id) => bodies.get(id) ?? null);
}

/** What goes back to her when a quote does not match, so the retry reads the message itself. */
export function quoteCorrection(mismatches: QuoteMismatch[]): string {
  const list = mismatches.map((m) => `- "${m.quote}" is not in [msg:${m.messageId}]`).join("\n");
  return `Your answer quotes text that the message it cites does not contain:\n${list}\n\nDo not answer from earlier in this conversation. Look the message up again now with search_inbox or get_thread, and answer again quoting only words copied exactly from what a tool returns in this turn. If you cannot find it, say so.`;
}

/** Said under an answer whose quote still does not match after the retry. */
export const QUOTE_WARNING = "Check this against the message itself: a quote above does not match the message it cites.";
