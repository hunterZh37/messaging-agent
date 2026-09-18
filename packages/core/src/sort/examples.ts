import { and, desc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import { messages, sorts } from "../db/schema";
import { DOCUMENT_PREFIX, embedTextFor } from "../projects/classify";
import { EmbeddingsUnavailableError, type Embedder } from "../projects/embedder";
import { assignedProjectName } from "../projects/projects";
import { stripQuoted } from "../text/quoted";
import { OTHER } from "./categories";
import type { Finance, SortInput, SortResult } from "./types";

/**
 * Worked examples for the trickle model (spec 7a). The small local model
 * agrees with the backlog model on importance and money but guesses at
 * needs_reply and the sub-category, and what it is missing is not more rules
 * but this operator's answers: six messages it has already seen judged, from
 * the same inbox, nearest to the one in front of it.
 *
 * Only trusted verdicts are shown. A trickle verdict is never an example:
 * a wrong qwen3 answer today must not become tomorrow's precedent.
 */

/** How many examples ride along with one message, unless the caller says otherwise. */
export const DEFAULT_EXAMPLE_COUNT = 6;

/** The heading the examples block wears in the user message. */
export const EXAMPLES_HEADING = "# Already judged in this inbox (examples)";

/** The verdict as the example shows it: what the sorter answers, minus the prose. */
export type ExampleVerdict = Omit<SortResult, "reason">;

export interface SortExample {
  /** `Name <address>`, or the address alone when the sender had no name. */
  fromLine: string;
  subject: string;
  /** The first two lines the sender wrote, quoted history dropped. */
  snippet: string;
  verdict: ExampleVerdict;
}

/**
 * A verdict worth learning from: a model other than the trickle one made
 * it. Nothing marks a hand correction yet (`labeled_at` records when the
 * provider label was applied, whatever model judged), so until such a mark
 * exists the operator's corrections are not distinguished. Pass the
 * trickle model's name in from config; core reads no environment of its own.
 */
export function trustedVerdictCondition(trustedModels: string[]): SQL {
  if (trustedModels.length === 0) return sql`0`;
  return inArray(sorts.model, trustedModels);
}

/** Every model that has judged mail here except the trickle one: Haiku, in practice. */
export function trustedModelNames(db: Db, trickleModel: string): string[] {
  return db.selectDistinct({ model: sorts.model }).from(sorts).where(ne(sorts.model, trickleModel)).all().map((r) => r.model);
}

export interface FindExamplesOptions {
  k?: number;
  /** The model whose own verdicts are not evidence: `cfg.models.sorter`, formatted. */
  trickleModel: string;
}

/**
 * The k nearest trusted verdicts to one message, for its own inbox. Falls
 * back to recency when there is no vector to search by, because a sorter
 * that cannot reach Ollama must still sort.
 */
export async function findExamples(
  db: Db,
  embedder: Embedder,
  input: SortInput & { id: string; accountId: string },
  opts: FindExamplesOptions,
): Promise<SortExample[]> {
  const k = opts.k ?? DEFAULT_EXAMPLE_COUNT;
  if (k <= 0) return [];
  const trusted = trustedVerdictCondition(trustedModelNames(db, opts.trickleModel));
  const ids = (await nearestTrusted(db, embedder, input, k, trusted)) ?? recentTrusted(db, input, k, trusted);
  return ids.map((id) => exampleFor(db, id)).filter((e): e is SortExample => e !== null);
}

/**
 * sqlite-vec answers a KNN query without knowing which rows are trusted, so
 * it is asked for several times as many neighbours as are wanted and the
 * filtering happens here, in the KNN's own order.
 */
const KNN_OVERSAMPLE = 4;

/** `null` means "no vector search happened": the caller falls back to recency. */
async function nearestTrusted(
  db: Db,
  embedder: Embedder,
  input: SortInput & { id: string; accountId: string },
  k: number,
  trusted: SQL,
): Promise<string[] | null> {
  if (!db.vecAvailable) return null;

  let vector: Float32Array;
  try {
    // The stored neighbours were embedded as documents, so the message being
    // judged is embedded as one too: matching a document against documents
    // keeps both vectors in the space nomic put them in.
    const [v] = await embedder.embed([`${DOCUMENT_PREFIX}${embedTextFor(input)}`]);
    if (!v) return null;
    vector = v;
  } catch (err) {
    if (err instanceof EmbeddingsUnavailableError) return null;
    throw err;
  }

  let rows: { message_id: string }[];
  try {
    rows = db.$client
      .prepare("SELECT message_id, distance FROM message_embeddings WHERE embedding MATCH ? AND k = ?")
      .all(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), k * KNN_OVERSAMPLE) as { message_id: string }[];
  } catch {
    return null;
  }
  // Nothing embedded yet is the same situation as no vector table at all.
  if (rows.length === 0) return null;

  const candidates = rows.map((r) => r.message_id).filter((id) => id !== input.id);
  if (candidates.length === 0) return [];
  const keep = new Set(
    db
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(sorts, eq(sorts.messageId, messages.id))
      .where(and(inArray(messages.id, candidates), eq(messages.accountId, input.accountId), trusted))
      .all()
      .map((r) => r.id),
  );
  return candidates.filter((id) => keep.has(id)).slice(0, k);
}

/**
 * With no vector to search by, the next best thing is the same sender's
 * organisation: mail from a domain tends to be judged the same way twice.
 * The rest of the list is whatever this inbox judged most recently.
 */
function recentTrusted(db: Db, input: SortInput & { id: string; accountId: string }, k: number, trusted: SQL): string[] {
  const pick = (extra: SQL[]): string[] =>
    db
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(sorts, eq(sorts.messageId, messages.id))
      .where(and(eq(messages.accountId, input.accountId), ne(messages.id, input.id), eq(messages.isFromOperator, false), trusted, ...extra))
      .orderBy(desc(messages.sentAt))
      .limit(k)
      .all()
      .map((r) => r.id);

  const domain = input.fromAddress.split("@")[1]?.toLowerCase();
  const out = domain ? pick([sql`lower(${messages.fromAddress}) like ${`%@${domain}`}`]) : [];
  if (out.length >= k) return out.slice(0, k);
  for (const id of pick([])) {
    if (out.length >= k) break;
    if (!out.includes(id)) out.push(id);
  }
  return out.slice(0, k);
}

/** How many of the sender's own lines an example shows. */
const SNIPPET_LINES = 2;

/** And how much of them: enough to recognise the message, not enough to crowd the prompt. */
const SNIPPET_CHARS = 240;

function snippetOf(bodyText: string): string {
  return stripQuoted(bodyText)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, SNIPPET_LINES)
    .join("\n")
    .slice(0, SNIPPET_CHARS);
}

function exampleFor(db: Db, messageId: string): SortExample | null {
  const row = db
    .select({
      fromAddress: messages.fromAddress,
      fromName: messages.fromName,
      subject: messages.subject,
      bodyText: messages.bodyText,
      sort: sorts,
    })
    .from(messages)
    .innerJoin(sorts, eq(sorts.messageId, messages.id))
    .where(eq(messages.id, messageId))
    .get();
  if (!row) return null;
  return {
    fromLine: row.fromName ? `${row.fromName} <${row.fromAddress}>` : row.fromAddress,
    subject: row.subject,
    snippet: snippetOf(row.bodyText),
    verdict: {
      important: row.sort.important,
      needs_reply: row.sort.needsReply,
      scheduling: row.sort.scheduling,
      // Mail that is not important carries no sub-category, and the sorter
      // answers "Other" for it, so that is what the example shows.
      category: row.sort.category ?? OTHER,
      finance: row.sort.finance as Finance,
      disposable: row.sort.disposable,
      project: assignedProjectName(db, messageId),
    },
  };
}

/** The block as the trickle model reads it. No examples renders nothing at all. */
export function renderExamples(examples: SortExample[]): string {
  if (examples.length === 0) return "";
  const blocks = examples.map((e) =>
    [`From: ${e.fromLine}`, `Subject: ${e.subject}`, e.snippet, `Verdict: ${JSON.stringify(e.verdict)}`].filter((line) => line !== "").join("\n"),
  );
  return [EXAMPLES_HEADING, ...blocks].join("\n\n");
}
