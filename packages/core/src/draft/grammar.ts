import type { ModelProvider } from "../models/types";

/**
 * Fix the grammar and nothing else (operator, 2026-09-25: "one quick button
 * for Fix Grammar and all it does is fix the grammatical errors in my email.
 * It doesn't change anything else, just fixes grammatical errors").
 *
 * The whole body comes back corrected, which is what the operator asked for,
 * and the danger in that is a model that takes the invitation to rewrite. So
 * what comes back is measured against what went in, in order, and the things
 * a correction must never touch are checked by name: the numbers, the links,
 * the addresses, the marks around emphasised words. Their words are theirs,
 * and a button that quietly reworded them would be worse than no button.
 */

const MAX_TOKENS = 2000;

const RULES = `You are a proofreader. You fix grammar, spelling and punctuation in an email the operator has written, and you change nothing else.

Fix: verb agreement and tense, articles, plurals, prepositions, misspellings, capitalisation of names and sentence starts, punctuation, and a word used where a near-identical one is meant ("assist" where "assistance" is meant).

Never: reword a sentence that is already correct, change the tone, shorten or expand anything, reorder sentences, add or remove a sentence, add or remove a greeting or sign-off, change names, addresses, links, numbers, dates or amounts, or "improve" the style. British and American spellings are both correct: leave whichever they used.

Keep every line break exactly as it is, including blank lines. Keep any ** or __ marks around words exactly where they are: they carry the operator's emphasis.

Answer in the same language the email is written in.

Answer with the corrected email body and nothing else. No preamble, no explanation, no quotation marks around it. If there is nothing to fix, answer with the body exactly as it came.`;

export interface GrammarResult {
  /** The corrected body, or the original when nothing was changed. */
  text: string;
  /** Whether anything actually changed. */
  changed: boolean;
  /**
   * Set when the reply was refused: the model rewrote rather than corrected,
   * and the operator's own words are kept instead.
   */
  refused?: string;
}

/**
 * The pieces a correction works on. A run of letters is one piece; a Chinese,
 * Japanese or Thai character is one piece on its own, because those scripts
 * do not put spaces between words and a whole clause would otherwise count as
 * a single token — one character fixed then looked like the clause being
 * thrown away (review, 2026-09-25).
 */
export function tokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]|[\p{L}\p{N}']+/gu) ?? [];
}

/**
 * How much of the draft survived, in the order it was written.
 *
 * The longest run of pieces still in sequence, over what went in. A bag of
 * words would call a mail with its sentences shuffled untouched; this does
 * not (review, 2026-09-25).
 */
export function kept(before: string, after: string): number {
  const was = tokens(before);
  const now = tokens(after);
  if (was.length === 0) return 1;
  // Longest common subsequence, row by row: drafts are short enough that the
  // simple table is the right amount of cleverness.
  let previous = new Array<number>(now.length + 1).fill(0);
  for (const a of was) {
    const row = new Array<number>(now.length + 1).fill(0);
    for (let j = 0; j < now.length; j++) {
      row[j + 1] = a === now[j] ? (previous[j] ?? 0) + 1 : Math.max(row[j] ?? 0, previous[j + 1] ?? 0);
    }
    previous = row;
  }
  return (previous[now.length] ?? 0) / was.length;
}

/** Below this, it is not a correction any more. Two pieces in three stay. */
export const KEEP_AT_LEAST = 0.66;

/**
 * What a proofreader may not touch, whatever else it does: a number, a sum,
 * a date, a link, an address. The prompt says so, and an eight billion
 * parameter model on a laptop is not a reason to take its word for it.
 */
export function facts(text: string): string[] {
  const found = [
    ...(text.match(/https?:\/\/\S+/gu) ?? []),
    ...(text.match(/[^\s@]+@[^\s@]+\.[^\s@,;]+/gu) ?? []),
    ...(text.match(/\d[\d,.:/-]*/gu) ?? []),
  ];
  return found.map((f) => f.replace(/[.,;:]+$/, "")).filter((f) => f !== "");
}

/**
 * The first line and the last are where a mail says hello and signs off, and
 * a correction leaves both where they are. A rewrite that shuffles the
 * paragraphs moves them, which the run-in-order measure alone can miss when
 * one paragraph is much the longest (found by its own test, 2026-09-25).
 */
function endsHeld(before: string, after: string): boolean {
  const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const was = lines(before);
  const now = lines(after);
  if (was.length < 2 || now.length < 2) return true;
  const share = (a: string, b: string) => {
    const left = tokens(a);
    if (left.length === 0) return 1;
    const right = new Set(tokens(b));
    return left.filter((t) => right.has(t)).length / left.length;
  };
  return share(was[0]!, now[0]!) >= 0.5 && share(was.at(-1)!, now.at(-1)!) >= 0.5;
}

/** How many words are marked bold or underlined, which a correction keeps. */
function marks(text: string): number {
  return (text.match(/\*\*|__/gu) ?? []).length;
}

/** The lines of the draft, which a correction does not rearrange. */
function lineShape(text: string): number {
  return text.split("\n").length;
}

export async function fixGrammar(provider: ModelProvider, body: string): Promise<GrammarResult> {
  const original = body;
  if (original.trim() === "") return { text: original, changed: false };

  const result = await provider.text({
    system: [{ text: RULES, cache: true }],
    messages: [{ role: "user", content: original }],
    maxTokens: MAX_TOKENS,
  });

  const answer = unwrap(result.text);
  if (answer.trim() === "") return { text: original, changed: false, refused: "The model answered with nothing." };

  // Whatever the draft ended with is the operator's: a trailing blank line
  // before a signature is theirs to keep, and trimming it made an unchanged
  // answer look like a change and a longer one look rewritten (review,
  // 2026-09-25).
  const tail = /\s*$/.exec(original)?.[0] ?? "";
  // Local models like to leave two spaces at the end of a line, which is a
  // markdown break and not a correction. Taken off, unless the operator put
  // trailing spaces there themselves (seen live, 2026-09-25).
  const theirs = original.split("\n").some((line) => /\s$/.test(line) && line.trim() !== "");
  const tidy = theirs ? answer : answer.split("\n").map((line) => line.replace(/[ \t]+$/, "")).join("\n");
  const corrected = tidy.replace(/\s*$/, "") + tail;

  if (kept(original, corrected) < KEEP_AT_LEAST) {
    return { text: original, changed: false, refused: "That came back rewritten rather than corrected, so your draft is untouched." };
  }
  if (Math.abs(lineShape(corrected) - lineShape(original)) > 2) {
    return { text: original, changed: false, refused: "That came back laid out differently, so your draft is untouched." };
  }
  if (!endsHeld(original, corrected)) {
    return { text: original, changed: false, refused: "That came back with the greeting or sign-off moved, so your draft is untouched." };
  }
  const lost = facts(original).filter((f) => !corrected.includes(f));
  if (lost.length > 0) {
    return { text: original, changed: false, refused: `That changed ${lost[0]}, which a grammar fix should not, so your draft is untouched.` };
  }
  if (marks(corrected) !== marks(original)) {
    return { text: original, changed: false, refused: "That moved the bold or underline marks, so your draft is untouched." };
  }

  return { text: corrected, changed: corrected !== original };
}

/** A fenced or quoted answer, unwrapped. */
function unwrap(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-z]*\n([\s\S]*?)\n?```$/i.exec(trimmed);
  if (fenced?.[1]) return fenced[1];
  return trimmed;
}
