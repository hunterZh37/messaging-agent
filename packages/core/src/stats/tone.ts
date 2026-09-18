import { z } from "zod";
import { asc, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { toneMonths, type ToneMonthRow } from "../db/schema";
import type { ModelProvider } from "../models/types";
import { formatModelRef } from "../models/types";
import { ownWords } from "./own-words";

/**
 * How the operator's own writing read, month by month (spec 14, added
 * 2026-09-17).
 *
 * The whole module is about one person: the operator. It reads a sample of
 * what they themselves wrote and says how it comes across. It is never asked
 * about a correspondent, because guessing at the inner state of somebody who
 * cannot see the guess or argue with it is not a thing this app should do,
 * and a model that is invited to do it once will do it unprompted later.
 *
 * The default model is local (`MODELS.stats`). Tens of thousands of the
 * operator's own messages is the last body of text that should be sent
 * anywhere, and the reading is re-runnable only because it costs nothing.
 */

/** What the model is asked to return, and the only shape that is stored. */
export const toneSchema = z.object({
  tone: z.string().min(1).max(60),
  energy: z.enum(["low", "steady", "high"]),
  warmth: z.enum(["guarded", "neutral", "warm"]),
  note: z.string().min(1).max(240),
});
export type ToneReading = z.infer<typeof toneSchema>;

/**
 * Held to the operator by every sentence. The model is told the messages are
 * one person's outgoing words and that the other side is absent, so it cannot
 * mistake a quoted line for a correspondent and start describing them.
 */
const SYSTEM = `You are reading one person's outgoing messages to describe how THAT PERSON came across in writing, over one month.

Rules:
- Every message shown was written and sent by the same one person. The people they were writing to are not here and are not your subject.
- Describe only the writer: their manner, their energy, how warm or guarded they sound.
- Never describe, name, or guess at anyone else, and never guess why they wrote as they did.
- Judge only the writing in front of you. Do not infer life events, health, or relationships.
- Short chat messages are normal and are not coldness. Compare the month to how people write in general, not to formal prose.

Fields:
- tone: two to four words for the manner of the writing, e.g. "brisk and practical".
- energy: "low" if replies are mostly short and flat; "steady" for ordinary back and forth; "high" for fast, eager, exclamatory writing.
- warmth: "guarded" if it is mostly transactional; "neutral" for ordinary friendliness; "warm" for affectionate, playful or effusive writing.
- note: ONE sentence, at most 25 words. It must agree with the other three fields.

Answer with JSON only.`;

/**
 * A month too thin to read. Three messages is a dry spell, not a mood, and a
 * model handed three will describe them confidently anyway.
 */
export const MIN_SAMPLE = 12;

/** How many of the operator's messages one month's reading is drawn from. */
export const SAMPLE_SIZE = 60;

/**
 * An evenly spread sample of what the operator wrote in one month, quoted
 * threads stripped. Spread rather than the first N, so a month whose first
 * day was one long argument does not stand for the whole of it.
 */
export function monthSample(db: Db, month: string, size = SAMPLE_SIZE): string[] {
  const rows = db.$client
    .prepare(
      `select body_text from messages
       where is_from_operator = 1
         and body_text is not null
         and strftime('%Y-%m', sent_at / 1000, 'unixepoch', 'localtime') = ?
       order by sent_at, id`,
    )
    .all(month) as { body_text: string | null }[];

  const words = rows.map((r) => ownWords(r.body_text)).filter((w): w is string => w !== null);
  if (words.length <= size) return words;
  const step = words.length / size;
  return Array.from({ length: size }, (_, i) => words[Math.floor(i * step)]!);
}

/**
 * Whether a month holds enough of the operator's *own* words to read.
 *
 * Counting rows will not do. An old month can hold twenty sent mails that are
 * each a forward with nothing written above the quote, and those strip to
 * nothing: one month here had twenty-two messages and one sentence. Counting
 * raw rows left the page offering months that could never be read and asking
 * the model about them again on every run.
 *
 * Stops as soon as the threshold is met, so a busy month reads a dozen rows
 * rather than two thousand.
 */
function readable(db: Db, month: string): boolean {
  const rows = db.$client
    .prepare(
      `select body_text from messages
       where is_from_operator = 1 and body_text is not null
         and strftime('%Y-%m', sent_at / 1000, 'unixepoch', 'localtime') = ?
       order by sent_at, id`,
    )
    .iterate(month) as Iterable<{ body_text: string | null }>;

  let found = 0;
  for (const row of rows) {
    if (ownWords(row.body_text) !== null && (found += 1) >= MIN_SAMPLE) return true;
  }
  return false;
}

/**
 * Months that hold enough rows to be worth stripping, oldest first. One
 * grouped count, and the expensive `readable` test is left to whoever
 * actually needs it.
 */
function candidateMonths(db: Db): string[] {
  return (
    db.$client
      .prepare(
        `select strftime('%Y-%m', sent_at / 1000, 'unixepoch', 'localtime') as month
         from messages
         where is_from_operator = 1 and length(trim(coalesce(body_text, ''))) >= 2
         group by month having count(*) >= ${MIN_SAMPLE} order by month`,
      )
      .all() as { month: string }[]
  ).map((r) => r.month);
}

/** Months with enough of the operator's own writing in them to read, oldest first. */
export function monthsWithMessages(db: Db): string[] {
  return candidateMonths(db).filter((m) => readable(db, m));
}

/** The readings already stored, oldest first, for the page to draw. */
export function readings(db: Db): ToneMonthRow[] {
  return db.select().from(toneMonths).orderBy(asc(toneMonths.month)).all();
}

/**
 * Read one month and store it. Returns null when the month holds too little
 * to say anything about, which is left unstored so a later run can try again
 * once more of that month has synced.
 */
export async function readMonth(db: Db, provider: ModelProvider, month: string): Promise<ToneMonthRow | null> {
  const sample = monthSample(db, month);
  if (sample.length < MIN_SAMPLE) return null;

  const { output } = await provider.structured({
    system: [{ text: SYSTEM, cache: true }],
    messages: [
      {
        role: "user",
        content: `Messages one person sent during ${month}:\n\n${sample.map((s) => `- ${s}`).join("\n")}`,
      },
    ],
    schema: toneSchema,
    maxTokens: 400,
  });

  const row = {
    month,
    tone: output.tone.trim().slice(0, 60),
    energy: output.energy,
    warmth: output.warmth,
    note: output.note.trim().slice(0, 240),
    sampled: sample.length,
    model: formatModelRef(provider.ref),
    readAt: Date.now(),
  };
  db.insert(toneMonths)
    .values(row)
    .onConflictDoUpdate({ target: toneMonths.month, set: row })
    .run();
  return row;
}

/**
 * Months that have no reading yet, newest first: the recent ones matter most.
 *
 * Months already read are dropped *before* the stripping test rather than
 * after. The stats page asks for this count on every render, and testing all
 * of them cost a third of a second on every click of the range chips even
 * when every month had already been read (operator, 2026-09-17: not snappy).
 */
export function unreadMonths(db: Db): string[] {
  const done = new Set(
    (db.$client.prepare(`select month from tone_months`).all() as { month: string }[]).map((r) => r.month),
  );
  return candidateMonths(db)
    .filter((m) => !done.has(m))
    .filter((m) => readable(db, m))
    .reverse();
}

export interface ReadProgress {
  month: string;
  done: number;
  total: number;
}

/**
 * Read every month that has no reading, newest first, stopping when `signal`
 * aborts. Each month is stored as it finishes, so a run that is interrupted
 * after forty minutes has kept forty minutes of work.
 */
export async function readAll(
  db: Db,
  provider: ModelProvider,
  opts: { signal?: AbortSignal; onProgress?: (p: ReadProgress) => void } = {},
): Promise<number> {
  const months = unreadMonths(db);
  let done = 0;
  for (const month of months) {
    if (opts.signal?.aborted) break;
    await readMonth(db, provider, month);
    done += 1;
    opts.onProgress?.({ month, done, total: months.length });
  }
  return done;
}

/** Wipe every reading, for a re-run after the model or the prompt changes. */
export function clearReadings(db: Db): void {
  db.run(sql`delete from ${toneMonths}`);
}
