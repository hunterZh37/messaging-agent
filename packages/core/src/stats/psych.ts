import { z } from "zod";
import { asc, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { psychAxes, psychDeclared, psychEvidence, type PsychAxisRow, type PsychEvidenceRow } from "../db/schema";
import type { ModelProvider } from "../models/types";
import { formatModelRef } from "../models/types";
import { ownWords } from "./own-words";
import { messagingStats } from "./stats";

/**
 * Whether the operator's own messages bear out the MBTI type they claim
 * (operator, 2026-09-17: find the message that backs up your reasoning, then:
 * I want INTJ).
 *
 * The type is declared, not inferred. Four readings of the same archive gave
 * four different types, so a guessed type was never worth the pixels; what is
 * worth something is holding a claim up against seven years of evidence and
 * saying where it holds and where it does not. The disagreements are the
 * interesting part, so they are shown, not buried.
 *
 * Two things this module refuses to do, because a verdict about somebody's
 * character is the easiest thing in the app to make up.
 *
 * It never lets the model write the evidence. The model is shown a numbered
 * sample and may only answer with numbers; the text under each verdict is
 * then fetched from the database, so what the operator reads is their own
 * message as they sent it rather than the model's memory of it. An earlier
 * attempt that let it quote freely produced a line the operator never wrote.
 *
 * And it never hides disagreement. Each axis is read several times over
 * different samples and the row keeps how many runs agreed, because the model
 * says "high confidence" for an axis that flipped between runs just as
 * readily as for one that did not.
 */

export const AXES = [
  { axis: "E/I", a: "E", b: "I", aName: "Extravert", bName: "Introvert", question: "Extraversion (E) or Introversion (I)", guide: "E = starts conversations, reaches outward, thinks by talking, energised by contact. I = answers rather than opens, keeps counsel, fewer and shorter words to more people." },
  { axis: "S/N", a: "S", b: "N", aName: "Sensing", bName: "Intuition", question: "Sensing (S) or Intuition (N)", guide: "S = trusts concrete detail, precedent, logistics, what has actually worked, facts as given. N = trusts patterns, implications, where a thing is heading, abstraction, possibility." },
  { axis: "T/F", a: "T", b: "F", aName: "Thinking", bName: "Feeling", question: "Thinking (T) or Feeling (F)", guide: "T = decides by logic and consequence, states the position, impersonal about problems. F = decides by values and effect on people, tends the relationship, names feelings." },
  { axis: "J/P", a: "J", b: "P", aName: "Judging", bName: "Perceiving", question: "Judging (J) or Perceiving (P)", guide: "J = settles things, plans ahead, wants the matter closed, keeps to arrangements. P = keeps options open, improvises, resists being pinned down, comfortable leaving things unsettled." },
] as const;

export type AxisKey = (typeof AXES)[number]["axis"];

/** How many of the operator's messages one axis is judged from. */
export const PSYCH_SAMPLE_SIZE = 150;
/**
 * Readings per axis, each over a different sample. Odd, so a majority always
 * exists, and five rather than three because three agreeing says very little:
 * on a first attempt every axis came back 3/3 and the whole type still
 * changed when the sample did (2026-09-17).
 */
export const PSYCH_RUNS = 5;
/** Messages cited per verdict. Enough to show a pattern, few enough to read. */
const EVIDENCE = 3;

interface Sampled {
  id: string;
  sentAt: number;
  text: string;
}

/**
 * The operator's own words, spread evenly across everything they have ever
 * sent, quoted threads stripped. `offset` shifts the whole comb so a second
 * run sees different messages and its agreement means something.
 */
export function psychSample(db: Db, size = PSYCH_SAMPLE_SIZE, offset = 0): Sampled[] {
  const rows = db.$client
    .prepare(
      `select id, sent_at, body_text from messages
       where is_from_operator = 1 and body_text is not null
       order by sent_at, id`,
    )
    .all() as { id: string; sent_at: number; body_text: string | null }[];

  const kept: Sampled[] = [];
  for (const r of rows) {
    const text = ownWords(r.body_text, 180);
    // "ok", "haha", "on my way" tell nobody anything, and a verdict citing
    // one reads as a machine grasping. Five words is the floor for being
    // quoted underneath a claim about somebody's character.
    if (text !== null && text.split(" ").length >= 5) kept.push({ id: r.id, sentAt: r.sent_at, text });
  }
  if (kept.length <= size) return kept;

  const step = kept.length / size;
  return Array.from({ length: size }, (_, i) => kept[Math.min(kept.length - 1, Math.floor(i * step + offset * (step / PSYCH_RUNS)))]!);
}

/**
 * What the whole archive measures, handed to every axis.
 *
 * Without it the model read eighty messages, saw questions and plans in them,
 * and called the operator an extravert who "initiates conversations" — while
 * the count over five thousand conversations says they open 14% of them
 * (2026-09-17). A sample cannot see a rate, so the rate has to be given, and
 * the model has to be told it outranks the impression.
 */
function facts(db: Db): string {
  const s = messagingStats(db, null);
  const h = s.habits;
  const pc = (n: number, of: number) => (of === 0 ? 0 : Math.round((n / of) * 100));
  const chat = s.replyTimes.find((r) => r.source === "chats")?.medianMinutes;
  return `MEASURED OVER EVERY MESSAGE THEY HAVE EVER SENT (${s.totals.sent} of them, across ${h.threadsTotal} conversations, 2019 to now). These are counts, not impressions, and they outrank anything you think you see in the sample:
- They opened ${pc(h.startedByYou, h.threadsTotal)}% of conversations. The other side opened the rest.
- They had the last word in ${pc(h.lastWordYours, h.threadsTotal)}% of conversations.
- Their median message is ${h.medianWordsYou} words; the people writing to them use ${h.medianWordsThem}.
- ${pc(h.doubleTexts, s.totals.sent)}% of their messages follow their own previous one back to back.
- ${pc(h.questionsAsked, s.totals.sent)}% of their messages ask a question.
- ${pc(h.lateNight, s.totals.sent)}% are sent between midnight and 5am.
- They answer a chat in about ${chat ?? "?"} minutes, typically.`;
}

/**
 * A citation has to carry the opening words of the message it points at, so
 * the claim can be checked against the list the model was shown.
 *
 * Without it the citations were close to random: the same 2019 message came
 * back as evidence for Introversion and against Intuition, and low numbers
 * came back far more often than they should have (2026-09-17). A model that
 * has to copy three words from the line it is citing either read that line or
 * is caught not having read it.
 */
const citationSchema = z.object({ n: z.number(), starts: z.string().min(1).max(80) });

const verdictSchema = z.object({
  verdict: z.enum(["supported", "mixed", "against"]),
  reasoning: z.string().min(1).max(400),
  forEvidence: z.array(citationSchema).max(8),
  againstEvidence: z.array(citationSchema).max(8),
});

/** The first few words, lowercased, for comparing a citation with its message. */
function opening(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join(" ");
}

function systemFor(ax: (typeof AXES)[number], claimed: string): string {
  const name = claimed === ax.a ? ax.aName : ax.bName;
  const otherName = claimed === ax.a ? ax.bName : ax.aName;
  return `A person says they are ${claimed} (${name}) rather than ${otherName}, on the MBTI axis ${ax.question}. Below are messages that person wrote. Decide whether their own messages bear that out.

${ax.guide}

Rules:
- The subject is the person who wrote these messages. Nobody else is your subject.
- Answer "supported" if the messages mostly read as ${name}, "against" if they mostly read as ${otherName}, "mixed" if they genuinely go both ways.
- Do not flatter the claim. A claim the messages do not support is the most useful thing you can report.
- Cite up to 2 messages for the claim and up to 2 against it. Cite against even when your verdict is "supported"; there is almost always something.
- Each citation is {"n": <the message number>, "starts": "<the first three words of that exact message, copied>"}. Copy them from the line you are citing. A citation whose words do not match its number is thrown away.
- Cite only messages that genuinely show the trait. Two real ones beat four vague ones, and none is better than a stretch.
- Where a counted rate contradicts your impression of the sample, the count wins. A sample cannot see a rate over thousands of conversations.
- These are messages to people who already know them. They do not show work, solitude, or inner life.

Answer with JSON only: {"verdict":"supported|mixed|against","reasoning":"one or two sentences naming what in the messages decided it","forEvidence":[<numbers>],"againstEvidence":[<numbers>]}`;
}

interface Verdict {
  verdict: "supported" | "mixed" | "against";
  reasoning: string;
  forCited: Sampled[];
  againstCited: Sampled[];
}

/** One axis, once, over one sample. */
async function readAxis(
  db: Db,
  provider: ModelProvider,
  ax: (typeof AXES)[number],
  claimed: string,
  offset: number,
  measured: string,
): Promise<Verdict | null> {
  const sample = psychSample(db, PSYCH_SAMPLE_SIZE, offset);
  if (sample.length < 20) return null;

  const { output } = await provider.structured({
    system: [{ text: systemFor(ax, claimed), cache: true }],
    messages: [
      {
        role: "user",
        content: `${measured}\n\nA SAMPLE OF THEIR OWN MESSAGES, SPREAD ACROSS EVERY YEAR:\n${sample.map((m, i) => `[${i}] ${m.text}`).join("\n")}`,
      },
    ],
    schema: verdictSchema,
    maxTokens: 700,
  });

  // A number outside the list is dropped rather than trusted. It cannot be
  // resolved to a message, and a citation nobody can check is worth nothing.
  // A citation is kept only if the words it copied match the message it
  // points at. Anything else is a number picked without reading, and a quote
  // under a verdict has to be one the model actually looked at.
  const resolve = (cites: { n: number; starts: string }[]) =>
    cites
      .filter((c) => Number.isInteger(c.n) && c.n >= 0 && c.n < sample.length)
      .filter((c) => opening(sample[c.n]!.text).startsWith(opening(c.starts).slice(0, 12)))
      .slice(0, EVIDENCE)
      .map((c) => sample[c.n]!);

  return {
    verdict: output.verdict,
    reasoning: output.reasoning.trim(),
    forCited: resolve(output.forEvidence),
    againstCited: resolve(output.againstEvidence),
  };
}

export interface PsychProgress {
  axis: string;
  done: number;
  total: number;
}

/** The type the operator claims, or null until they have said. */
export function declaredType(db: Db): string | null {
  const row = db.select().from(psychDeclared).all()[0];
  return row?.type ?? null;
}

/** Four letters, one per axis, in MBTI order. Anything else is refused. */
export function declareType(db: Db, type: string): void {
  const t = type.trim().toUpperCase();
  const ok = AXES.every((ax, i) => t[i] === ax.a || t[i] === ax.b);
  if (t.length !== 4 || !ok) throw new Error(`"${type}" is not an MBTI type`);
  db.insert(psychDeclared)
    .values({ id: "operator", type: t, setAt: Date.now() })
    .onConflictDoUpdate({ target: psychDeclared.id, set: { type: t, setAt: Date.now() } })
    .run();
}

/**
 * Hold the operator's claimed type against their own messages, axis by axis,
 * `PSYCH_RUNS` times over different samples. Stores the majority verdict and
 * the messages on both sides of it.
 */
export async function readPsych(
  db: Db,
  provider: ModelProvider,
  opts: { signal?: AbortSignal; onProgress?: (p: PsychProgress) => void } = {},
): Promise<number> {
  const claimed = declaredType(db);
  if (claimed === null) throw new Error("No type declared yet");

  const total = AXES.length * PSYCH_RUNS;
  let done = 0;
  const now = Date.now();
  const model = formatModelRef(provider.ref);
  const measured = facts(db);

  for (const [i, ax] of AXES.entries()) {
    const letter = claimed[i]!;
    const verdicts: Verdict[] = [];
    for (let run = 0; run < PSYCH_RUNS; run += 1) {
      if (opts.signal?.aborted) return done;
      const v = await readAxis(db, provider, ax, letter, run, measured);
      if (v) verdicts.push(v);
      done += 1;
      opts.onProgress?.({ axis: ax.axis, done, total });
    }
    if (verdicts.length === 0) continue;

    // The majority verdict, and how many runs reached it. A claim upheld by
    // three runs of five is not upheld, and the row has to say so.
    const tally = new Map<string, Verdict[]>();
    for (const v of verdicts) tally.set(v.verdict, [...(tally.get(v.verdict) ?? []), v]);
    const winners = [...tally.values()].sort((a, b) => b.length - a.length)[0]!;
    const verdict = winners[0]!.verdict;

    db.delete(psychEvidence).where(sql`${psychEvidence.axis} = ${ax.axis}`).run();
    const row = {
      axis: ax.axis,
      letter,
      verdict,
      agreement: winners.length,
      runs: verdicts.length,
      confidence: (winners.length === verdicts.length ? "high" : winners.length >= verdicts.length - 1 ? "medium" : "low") as "low" | "medium" | "high",
      reasoning: winners[0]!.reasoning,
      model,
      readAt: now,
    };
    db.insert(psychAxes).values(row).onConflictDoUpdate({ target: psychAxes.axis, set: row }).run();

    // Both sides are kept whatever the verdict: what argues against the claim
    // is the part the operator cannot get anywhere else.
    for (const side of ["for", "against"] as const) {
      const seen = new Set<string>();
      for (const v of winners) {
        for (const m of side === "for" ? v.forCited : v.againstCited) {
          if (seen.has(m.id) || seen.size >= EVIDENCE) continue;
          seen.add(m.id);
          db.insert(psychEvidence)
            .values({ id: `${ax.axis}:${side}:${m.id}`.replace(/\//g, "-"), axis: ax.axis, side, messageId: m.id, quote: m.text, sentAt: m.sentAt })
            .onConflictDoNothing()
            .run();
        }
      }
    }
  }
  return done;
}

export interface PsychAxisView extends PsychAxisRow {
  /** What the claimed letter is called, and what it is being claimed over. */
  name: string;
  other: string;
  /** Messages that bear the claim out, and messages that do not. */
  supports: PsychEvidenceRow[];
  against: PsychEvidenceRow[];
}

export interface PsychRead {
  /** The type the operator claims. Null until they have declared one. */
  type: string | null;
  /** True once every axis has been held up against the messages. */
  tested: boolean;
  axes: PsychAxisView[];
  model: string | null;
  readAt: number | null;
}

/** The claim, and how each letter of it stood up, in MBTI order. */
export function psychRead(db: Db): PsychRead {
  const type = declaredType(db);
  const rows = db.select().from(psychAxes).all();
  const evidence = db.select().from(psychEvidence).orderBy(asc(psychEvidence.sentAt)).all();

  const axes: PsychAxisView[] = [];
  for (const ax of AXES) {
    const row = rows.find((r) => r.axis === ax.axis);
    if (!row) continue;
    axes.push({
      ...row,
      name: row.letter === ax.a ? ax.aName : ax.bName,
      other: row.letter === ax.a ? ax.bName : ax.aName,
      supports: evidence.filter((e) => e.axis === ax.axis && e.side === "for"),
      against: evidence.filter((e) => e.axis === ax.axis && e.side === "against"),
    });
  }

  return { type, tested: axes.length === AXES.length, axes, model: rows[0]?.model ?? null, readAt: rows[0]?.readAt ?? null };
}

/** Clear the read, for a re-run after the model or the prompt changes. */
export function clearPsych(db: Db): void {
  db.run(sql`delete from ${psychEvidence}`);
  db.run(sql`delete from ${psychAxes}`);
}
