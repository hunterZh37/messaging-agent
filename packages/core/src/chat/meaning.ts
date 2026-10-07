import type { Db } from "../db/client";
import { EmbeddingsUnavailableError, type Embedder } from "../projects/embedder";
import { QUERY_PREFIX } from "../projects/classify";
import { ACCOUNT, COLUMNS, ftsQuery, narrow, toHits, type SearchFilters, type SearchRow } from "./search";
import type { SearchHit } from "./types";

/**
 * How many neighbours to ask the vector table for before the filters cut it
 * down. A question narrowed to one inbox would otherwise come back with
 * eight neighbours and keep two.
 */
const OVERSAMPLE = 6;

/**
 * The other way to find mail (operator, 2026-10-07: "we need to do semantic
 * search, definitely"). The keyword index knows the words a message contains
 * and nothing about what it meant, so a question worded differently from the
 * mail finds nothing and Celeste guesses again. This asks the vectors
 * instead: the question is embedded by the same local model that embedded
 * the mail, and the table answers with what is nearest.
 *
 * It never throws. The vectors may not have loaded, Ollama may not be
 * running, and the operator is still owed whatever the words alone can find.
 */
export async function searchByMeaning(db: Db, embedder: Embedder, query: string, opts: SearchFilters = {}): Promise<SearchHit[]> {
  if (!db.vecAvailable) return [];
  // A question with no words in it has no meaning to match. An embedding of
  // "???" is a direction like any other, and it would rank arbitrary mail
  // highly rather than nothing at all.
  if (!ftsQuery(query, "AND")) return [];

  let vector: Float32Array;
  try {
    // Asked as a question, against mail embedded as documents: the pair of
    // prefixes is what nomic was trained on, and mixing them up quietly
    // costs accuracy rather than failing.
    const [v] = await embedder.embed([`${QUERY_PREFIX}${query}`]);
    if (!v) return [];
    vector = v;
  } catch (err) {
    if (err instanceof EmbeddingsUnavailableError) return [];
    throw err;
  }

  const limit = opts.limit ?? 8;
  let near: { message_id: string }[];
  try {
    near = db.$client
      .prepare("SELECT message_id FROM message_embeddings WHERE embedding MATCH ? AND k = ?")
      .all(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), limit * OVERSAMPLE) as { message_id: string }[];
  } catch {
    return [];
  }
  if (near.length === 0) return [];

  // The rows, in the order the vectors put them: a message deleted since it
  // was embedded simply does not come back, and the filters narrow the rest.
  return hitsFor(db, near.map((r) => r.message_id), opts, limit);
}

/**
 * The rows behind a list of message ids, in the order the vectors put them.
 * The filters are the same ones the keyword half applies, so narrowing a
 * search to one inbox narrows both halves alike; a message deleted since it
 * was embedded has no row and simply does not come back. There is no
 * matched term to centre a snippet on, so it is the opening of the body, as
 * a search with filters and no words already does.
 */
function hitsFor(db: Db, ids: string[], filters: SearchFilters, limit: number): SearchHit[] {
  const { join, where, params } = narrow(filters);
  const holes = ids.map(() => "?").join(", ");
  const bound: (string | number)[] = [...(filters.projectId ? [filters.projectId] : []), ...ids, ...params];
  const rows = db.$client
    .prepare(
      `SELECT ${COLUMNS}, substr(replace(m.body_text, char(10), ' '), 1, 160) AS snippet
       FROM messages m${ACCOUNT}${join}
       WHERE m.id IN (${holes})${where.length > 0 ? ` AND ${where.join(" AND ")}` : ""}`,
    )
    .all(...bound) as SearchRow[];
  const byId = new Map(rows.map((r) => [r.message_id, r]));
  const kept: SearchRow[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) kept.push(row);
    if (kept.length === limit) break;
  }
  return toHits(kept);
}
