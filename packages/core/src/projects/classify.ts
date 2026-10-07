import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { Config } from "../config";
import { now, type Db } from "../db/client";
import { accounts, embeddingState, messages, projectAssignments, projects, sorts, threads, type ProjectRow } from "../db/schema";
import { applyWaiting, handledActions, scopeConditions, type CountScope } from "../queue/inbox";
import { stripQuoted } from "../text/quoted";
import { createOllamaEmbedder, EmbeddingsUnavailableError, type Embedder } from "./embedder";
import { groupKey, listProjects } from "./projects";

/** The key `countByProject` uses for messages that belong to no project. */
export const UNFILED_KEY = "unfiled";

/** The key `countByProject` uses for the total: the project bar's "All" tab. */
export const ALL_KEY = "all";

/**
 * Below this cosine similarity a message stays Unfiled (spec 10d). Set by
 * hand rather than learned: a wrong project is worse than none.
 */
export const DEFAULT_THRESHOLD = 0.55;

/**
 * How far the best project must beat the second-best before a message is
 * filed at all (spec 10d). Every score in a real inbox lands in a narrow
 * band, so clearing the threshold says little: what separates a real match
 * from a coin toss is the gap behind it. Without this, mail that is a little
 * like everything lands under whichever project happened to edge the others,
 * which is how an Immigration project fills up with invoices.
 */
export const DEFAULT_MARGIN = 0.04;

/** How much of a message the embedder sees, once it is down to its own words. */
const TEXT_CHARS = 1500;

/**
 * Where a signature or a footer starts: everything from here down says who
 * sent it, not what it is about, and it is the same boilerplate on every
 * message from that sender, which is exactly the noise that makes unrelated
 * mail look alike.
 */
const FOOTER_START = [
  /^--\s*$/,
  /^(sent from my|get outlook for|this email and any attachments|confidentiality notice|the information contained in this)/i,
];

/** A line that looks like contact details rather than a sentence. */
const CONTACT = /(https?:\/\/|www\.|\+?\d[\d\s().-]{7,}\d|\b\d{5}(-\d{4})?\b|\b(suite|ste\.?|floor|fl\.?|street|st\.?|avenue|ave\.?|road|rd\.?)\b)/i;

/** How many short contact-looking lines in a row mean the message is over. */
const CONTACT_RUN = 3;

/** A contact line is short: a real sentence that happens to hold a link is not one. */
const CONTACT_LINE_CHARS = 40;

/** Where the body stops being the message: the earlier of a footer marker and a run of contact lines. */
function cutFooter(lines: string[]): string[] {
  let run = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (FOOTER_START.some((re) => re.test(line))) return lines.slice(0, i);
    if (line.length > 0 && line.length < CONTACT_LINE_CHARS && CONTACT.test(line)) {
      run++;
      if (run >= CONTACT_RUN) return lines.slice(0, i - run + 1);
    } else if (line.length > 0) {
      run = 0;
    }
  }
  return lines;
}

/**
 * What the embedder reads for a message (spec 10d): the subject once, then
 * the part of the body the sender actually wrote. Quoted history goes first,
 * because a reply that carries three rounds of someone else's mail embeds as
 * that mail; then signatures and footers, because every message from a firm
 * ends in the same address block and it drowns the sentence that says what
 * the message is for. What is left is capped, collapsed, and it is this text
 * whose hash decides when a message needs embedding again.
 */
export function embedTextFor(message: { subject: string; bodyText: string }): string {
  const own = cutFooter(stripQuoted(message.bodyText).split(/\r?\n/))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  return `${message.subject.trim()}\n\n${own}`.slice(0, TEXT_CHARS).trim();
}

/** sha256 of the text a vector was made from, so a change to the rules above re-embeds. */
export function embedTextHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * nomic-embed-text is trained with task prefixes and is measurably worse
 * without them: the mail being filed is a document, the project it is being
 * matched against is the query.
 */
export const DOCUMENT_PREFIX = "search_document: ";
export const QUERY_PREFIX = "search_query: ";

/** Newest hand-filed messages per project used as exemplars. Older ones add little and cost time. */
const MAX_EXEMPLARS = 200;

/** How many messages one `embedPending` call puts through Ollama. */
const DEFAULT_EMBED_LIMIT = 200;

/**
 * Out of every batch, how many slots a never-embedded backlog can never
 * crowd out (2026-10-07). Without a reserved slice, a backlog at or above
 * `limit` starves the recheck sweep completely — at 94,149 messages and a
 * limit of 200 that is roughly 471 calls, about eight hours at the clock's
 * cadence, before a changed message's vector is touched even once, and
 * never if new mail keeps arriving a batch at a time. A message whose body
 * changed, or whose text the rules above now read differently, cannot be
 * made to wait behind that backlog for its vector to catch up. Most of this
 * slice hashes as still current and is dropped by the check below, so the
 * usual cost of reserving it is one small SELECT, not wasted embeddings —
 * but whatever it is spent on is not spent draining the backlog, so this
 * number is sized against `limit`, not fixed on its own: raise the batch
 * size and the staleness delay this bounds grows with it unless this grows
 * too, and shrink the batch toward this number and the backlog's drain
 * slows correspondingly, down to a crawl if the two are ever close.
 */
const RECHECK_SLICE = 10;

function requireVec(db: Db): void {
  if (!db.vecAvailable) throw new EmbeddingsUnavailableError("sqlite-vec failed to load");
}

/** Cosine similarity of two vectors: 1 identical, 0 unrelated. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

function toBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

// Buffers from SQLite sit at an arbitrary offset in a pooled ArrayBuffer, so
// the bytes are copied out before being read as floats.
function toVector(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}

/** SQLite caps the parameters in one statement; vectors are read a chunk at a time. */
const ID_CHUNK = 400;

function readVectors(db: Db, ids: string[]): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db.$client
      .prepare(`SELECT message_id, embedding FROM message_embeddings WHERE message_id IN (${placeholders})`)
      .all(...chunk) as { message_id: string; embedding: Buffer }[];
    for (const row of rows) out.set(row.message_id, toVector(row.embedding));
  }
  return out;
}

/**
 * Embeds messages whose vector is missing or out of date, newest first. Runs
 * before every classify pass and after every sync, so the cost is spread over
 * the mail as it arrives. A message is out of date when the text the rules
 * above produce no longer hashes to what was embedded — which is how a change
 * to those rules reaches mail that was already filed — and a row with no hash
 * at all was written before they existed, so it counts as stale too. Errors
 * from the embedder propagate: a half-embedded inbox is fine, a silently
 * unembedded one is not.
 *
 * Two different questions want vectors, and `scope` picks which one this call
 * is for. The default, `"projects"`, is what every caller asked for before
 * this scope existed and must keep asking for by not passing one: only
 * inbound mail in the folders the operator files (spec 10a). `"search"` is
 * wider, because looking something up by what it meant can mean any message
 * they might ask about, their own sent mail and their texts included.
 *
 * A backlog bigger than `limit` is meant to be cleared by calling this
 * again and again (2026-10-07, for the clock that will do exactly that):
 * each call must reach mail the last one did not, which is why what is
 * definitely unembedded is selected directly rather than through the
 * window a plain `ORDER BY ... LIMIT` would fix in place — a limit and a
 * hash check applied only after the window was already decided would keep
 * re-reading the same already-current rows at the top of it forever.
 */
export async function embedPending(
  db: Db,
  embedder: Embedder,
  opts: { accountId?: string; limit?: number; scope?: "projects" | "search" } = {},
  clock: () => number = now,
): Promise<{ embedded: number; reembedded: number }> {
  requireVec(db);
  // Two different questions want vectors. Filing a message under a project
  // only ever concerned inbound mail in the folders the operator lives in.
  // Searching by meaning concerns everything they might ask about, their own
  // sent mail and their texts included (operator, 2026-10-07: "everything,
  // email first"), and only junk is never worth the room.
  const forSearch = opts.scope === "search";
  const conditions = forSearch
    ? [ne(messages.folder, "junk")]
    : [eq(messages.isFromOperator, false), inArray(messages.folder, ["inbox", "sent"])];
  if (opts.accountId) conditions.push(eq(messages.accountId, opts.accountId));

  const limit = opts.limit ?? DEFAULT_EMBED_LIMIT;
  const select = {
    id: messages.id,
    subject: messages.subject,
    bodyText: messages.bodyText,
    embeddedHash: embeddingState.textHash,
    embeddedAt: embeddingState.embeddedAt,
  };
  // Email first, newest first within it (2026-10-07). Their mailbox is
  // 86,210 texts to 7,939 emails, so newest-first alone would spend its
  // first hour on texts while the complaint that started this was about
  // email. Texts follow, and the clock keeps going until there are none. The
  // projects scope has no texts to sort ahead of, so it keeps the single
  // newest-first order it always had. `messages.id` breaks the tie between
  // two messages sent in the same second, so the order is total: without it
  // the two queries below could hand the same message back twice on one
  // page and skip another on the next.
  const order = [...(forSearch ? [sql`${accounts.provider} IN ('imessage', 'whatsapp')`] : []), desc(messages.sentAt), messages.id];

  // A small slice of every batch goes to rechecking mail that already has a
  // vector, oldest-checked first, before the never-embedded bucket below
  // gets a chance to claim the rest of the limit. Taken second, this would
  // starve outright rather than merely slow down once the never-embedded
  // backlog reached `limit` on its own: 94,149 messages at a limit of 200
  // is some 471 calls, about eight hours at the clock's cadence, before a
  // changed message's vector was touched even once (2026-10-07). Most of
  // this slice hashes as still current; the comparison below is what
  // decides which of it actually needs a new vector.
  const recheck = db
    .select(select)
    .from(messages)
    .innerJoin(embeddingState, eq(embeddingState.messageId, messages.id))
    .innerJoin(accounts, eq(accounts.id, messages.accountId))
    .where(and(...conditions, isNotNull(embeddingState.textHash)))
    .orderBy(asc(embeddingState.embeddedAt), messages.id)
    .limit(Math.min(RECHECK_SLICE, limit))
    .all();

  // A message with no embedding_state row, or one whose hash was blanked by
  // the "no hash at all" rule above, is stale with no need to check: it is
  // selected directly rather than through a window the recheck slice above
  // has already taken a bite out of, so a backlog many pages deep keeps
  // surfacing new mail call after call instead of the same page's
  // already-current rows (2026-10-07: without this, a limited window plus
  // the hash check done in JS meant every repeat call re-read whatever was
  // already embedded, found it current, and reported nothing left to do
  // while unembedded mail further down was never reached).
  const neverEmbedded = db
    .select(select)
    .from(messages)
    .leftJoin(embeddingState, eq(embeddingState.messageId, messages.id))
    .innerJoin(accounts, eq(accounts.id, messages.accountId))
    .where(and(...conditions, or(isNull(embeddingState.messageId), isNull(embeddingState.textHash))))
    .orderBy(...order)
    .limit(limit - recheck.length)
    .all();

  const pending = [...neverEmbedded, ...recheck]
    .map((m) => ({ ...m, text: embedTextFor(m) }))
    .filter((m) => m.embeddedAt === null || m.embeddedHash === null || m.embeddedHash !== embedTextHash(m.text));
  if (pending.length === 0) return { embedded: 0, reembedded: 0 };

  const vectors = await embedder.embed(pending.map((m) => `${DOCUMENT_PREFIX}${m.text}`));
  const at = clock();
  const remove = db.$client.prepare("DELETE FROM message_embeddings WHERE message_id = ?");
  const insert = db.$client.prepare("INSERT INTO message_embeddings(message_id, embedding) VALUES (?, ?)");

  db.transaction((tx) => {
    pending.forEach((m, i) => {
      // A vector with no state row is left over from a crashed pass, and one
      // whose text has changed is simply wrong; either way it is replaced.
      remove.run(m.id);
      insert.run(m.id, toBuffer(vectors[i]!));
      tx.insert(embeddingState)
        .values({ messageId: m.id, embeddedAt: at, textHash: embedTextHash(m.text) })
        .onConflictDoUpdate({ target: embeddingState.messageId, set: { embeddedAt: at, textHash: embedTextHash(m.text) } })
        .run();
    });
  });
  return {
    embedded: pending.length,
    reembedded: pending.filter((m) => m.embeddedAt !== null).length,
  };
}

// Project vectors change only when the operator edits the words, so they are
// worth keeping for the life of the process. Keyed by id and text, which
// makes a rename or a reworded description a miss rather than a stale hit.
const projectVectorCache = new Map<string, Float32Array>();

function projectText(p: ProjectRow): string {
  return `${QUERY_PREFIX}${p.name}: ${p.description}`;
}

function cacheKey(p: ProjectRow): string {
  return `${p.id}:${createHash("sha1").update(projectText(p)).digest("hex")}`;
}

/** The vector for each of an inbox's projects, by project id. */
export async function projectVectors(db: Db, embedder: Embedder, accountId: string): Promise<Map<string, Float32Array>> {
  const rows = listProjects(db, accountId);
  const missing = rows.filter((p) => !projectVectorCache.has(cacheKey(p)));
  if (missing.length > 0) {
    const vectors = await embedder.embed(missing.map(projectText));
    missing.forEach((p, i) => projectVectorCache.set(cacheKey(p), vectors[i]!));
  }
  return new Map(rows.map((p) => [p.id, projectVectorCache.get(cacheKey(p))!]));
}

/** Only for tests and for a process that has just rewritten project text out of band. */
export function clearProjectVectorCache(): void {
  projectVectorCache.clear();
}

/**
 * Files every embedded inbound message of one inbox that the operator has
 * not filed by hand. A message scores against each project's own words and
 * against every message hand-filed there; the best project wins only if it
 * clears the threshold and beats the runner-up by the margin, otherwise the
 * message is recorded as Unfiled so the next pass knows it has been seen.
 * The score kept is the best one either way, so a near miss is legible.
 */
export async function classifyProjects(
  db: Db,
  embedder: Embedder,
  accountId: string,
  opts: { threshold?: number; margin?: number } = {},
  clock: () => number = now,
): Promise<{ filed: number; unfiled: number }> {
  requireVec(db);
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const margin = opts.margin ?? DEFAULT_MARGIN;

  const candidates = db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(embeddingState, eq(embeddingState.messageId, messages.id))
    .leftJoin(projectAssignments, eq(projectAssignments.messageId, messages.id))
    .where(
      and(
        eq(messages.accountId, accountId),
        eq(messages.isFromOperator, false),
        inArray(messages.folder, ["inbox", "sent"]),
        or(isNull(projectAssignments.messageId), eq(projectAssignments.source, "auto")),
      ),
    )
    .all()
    .map((r) => r.id);
  if (candidates.length === 0) return { filed: 0, unfiled: 0 };

  const vectors = await projectVectors(db, embedder, accountId);
  // No projects yet: everything is Unfiled, and saying so in a row per
  // message would be a lot of writing to record nothing.
  if (vectors.size === 0) return { filed: 0, unfiled: candidates.length };

  const exemplarRows = db
    .select({ projectId: projectAssignments.projectId, messageId: projectAssignments.messageId })
    .from(projectAssignments)
    .innerJoin(messages, eq(messages.id, projectAssignments.messageId))
    .innerJoin(embeddingState, eq(embeddingState.messageId, messages.id))
    .where(and(eq(messages.accountId, accountId), eq(projectAssignments.source, "manual"), isNotNull(projectAssignments.projectId)))
    .orderBy(desc(messages.sentAt))
    .all();

  const exemplarsByProject = new Map<string, string[]>();
  for (const row of exemplarRows) {
    if (!row.projectId || !vectors.has(row.projectId)) continue;
    const list = exemplarsByProject.get(row.projectId) ?? [];
    if (list.length >= MAX_EXEMPLARS) continue;
    list.push(row.messageId);
    exemplarsByProject.set(row.projectId, list);
  }

  const exemplarIds = [...new Set([...exemplarsByProject.values()].flat())];
  const messageVectors = readVectors(db, [...candidates, ...exemplarIds]);

  const at = clock();
  let filed = 0;
  let unfiled = 0;
  const decisions: { messageId: string; projectId: string | null; score: number }[] = [];

  for (const messageId of candidates) {
    const vector = messageVectors.get(messageId);
    if (!vector) continue; // state row without a vector: the next embed pass rewrites it

    // One score per project: how much it looks like the project's own words,
    // or like anything the operator filed there by hand.
    const scores: { projectId: string; score: number }[] = [];
    for (const [projectId, projectVector] of vectors) {
      let score = cosine(vector, projectVector);
      for (const exemplarId of exemplarsByProject.get(projectId) ?? []) {
        const exemplar = messageVectors.get(exemplarId);
        if (exemplar) score = Math.max(score, cosine(vector, exemplar));
      }
      scores.push({ projectId, score });
    }
    scores.sort((a, b) => b.score - a.score);

    const best = scores[0];
    const secondBest = scores[1]?.score ?? -1;
    // Good enough on its own, and clearly better than the runner-up. A
    // message that fits two projects almost equally belongs to neither until
    // the operator says otherwise.
    const won = best && best.score >= threshold && best.score - secondBest >= margin ? best.projectId : null;
    if (won) filed++;
    else unfiled++;
    decisions.push({ messageId, projectId: won, score: best?.score ?? 0 });
  }

  db.transaction((tx) => {
    for (const d of decisions) {
      tx.insert(projectAssignments)
        .values({ messageId: d.messageId, projectId: d.projectId, source: "auto", score: d.score, assignedAt: at })
        .onConflictDoUpdate({
          target: projectAssignments.messageId,
          set: { projectId: d.projectId, source: "auto", score: d.score, assignedAt: at },
        })
        .run();
    }
  });

  return { filed, unfiled };
}

/**
 * "Move to project…": files every message in the thread by hand. Manual
 * filings outrank the pass and become the exemplars that sharpen it, so this
 * teaches as well as files. Needs no embedder, and so works without Ollama.
 */
export function fileThread(db: Db, threadId: string, projectId: string | null, clock: () => number = now): { filed: number } {
  const ids = db.select({ id: messages.id }).from(messages).where(eq(messages.threadId, threadId)).all().map((r) => r.id);
  if (ids.length === 0) return { filed: 0 };
  const at = clock();
  db.transaction((tx) => {
    for (const messageId of ids) {
      tx.insert(projectAssignments)
        .values({ messageId, projectId, source: "manual", score: null, assignedAt: at })
        .onConflictDoUpdate({
          target: projectAssignments.messageId,
          set: { projectId, source: "manual", score: null, assignedAt: at },
        })
        .run();
    }
  });
  return { filed: ids.length };
}

/**
 * How many messages sit under each project, for the project bar's tab counts
 * (spec 10d). Counted over exactly the population `listInboxMessages` shows
 * for the same view — its folder, window, the tree's child row and the money
 * side all apply — so each number is what clicking that tab would show.
 * Keyed by project id, with `unfiled` for everything else (a message with a
 * null assignment and one the pass has never reached both read as Unfiled)
 * and `all` for the total, which is always present even at zero.
 */
export function countByProject(db: Db, opts: CountScope = {}): Record<string, number> {
  // Grouping by project, so the project filter is the one thing left out.
  const conditions = scopeConditions({ ...opts, projectId: undefined });
  const out: Record<string, number> = {};
  let all = 0;
  const add = (projectId: string | null, n: number) => {
    const key = projectId ?? UNFILED_KEY;
    out[key] = (out[key] ?? 0) + n;
    all += n;
  };

  // Sent's Waiting split reads the message text, so those two are counted by
  // reading the rows the conditions leave rather than by grouping in SQL. It
  // is the same `applyWaiting` the list uses, over a folder of a size the
  // operator wrote by hand.
  if ((opts.folder ?? "inbox") === "sent" && opts.status !== undefined) {
    const rows = db
      .select({
        projectId: projectAssignments.projectId,
        message: { sentAt: messages.sentAt, bodyText: messages.bodyText },
        thread: { lastFromOperator: threads.lastFromOperator, lastMessageAt: threads.lastMessageAt },
      })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .leftJoin(sorts, eq(sorts.messageId, messages.id))
      .leftJoin(projectAssignments, eq(projectAssignments.messageId, messages.id))
      .leftJoin(handledActions, and(eq(handledActions.messageId, messages.id), eq(handledActions.kind, "handled")))
      .where(and(...conditions))
      .all();
    for (const row of applyWaiting(rows, opts)) add(row.projectId, 1);
    out[ALL_KEY] = all;
    return withGroupCounts(db, out, opts.accountId);
  }

  const rows = db
    .select({ projectId: projectAssignments.projectId, count: sql<number>`count(*)` })
    .from(messages)
    .innerJoin(threads, eq(threads.id, messages.threadId))
    .leftJoin(sorts, eq(sorts.messageId, messages.id))
    .leftJoin(projectAssignments, eq(projectAssignments.messageId, messages.id))
    .leftJoin(handledActions, and(eq(handledActions.messageId, messages.id), eq(handledActions.kind, "handled")))
    .where(and(...conditions))
    .groupBy(projectAssignments.projectId)
    .all();
  for (const r of rows) add(r.projectId, r.count);
  out[ALL_KEY] = all;
  return withGroupCounts(db, out, opts.accountId);
}

/**
 * Each group's count, beside its projects' (2026-09-15): the sum of the
 * projects in it, since a message is filed under one project at most.
 */
function withGroupCounts(db: Db, out: Record<string, number>, accountId: string | undefined): Record<string, number> {
  const grouped = db
    .select({ id: projects.id, groupId: projects.groupId })
    .from(projects)
    .where(accountId ? and(isNotNull(projects.groupId), eq(projects.accountId, accountId)) : isNotNull(projects.groupId))
    .all();
  for (const p of grouped) {
    const key = groupKey(p.groupId!);
    out[key] = (out[key] ?? 0) + (out[p.id] ?? 0);
  }
  return out;
}

/**
 * The whole projects pass for one inbox: embed what is new, then file it.
 * Every caller runs it inside a try/catch, because an inbox with no Ollama
 * must still sync.
 */
export async function runProjectsPass(
  db: Db,
  cfg: Config,
  accountId: string,
  embedder: Embedder = createOllamaEmbedder(cfg.ollamaUrl, cfg.embedModel, { db, accountId }),
): Promise<{ embedded: number; filed: number; unfiled: number; reembedded: number }> {
  requireVec(db);
  const { embedded, reembedded } = await embedPending(db, embedder, { accountId });
  const { filed, unfiled } = await classifyProjects(db, embedder, accountId);
  return { embedded, filed, unfiled, reembedded };
}
