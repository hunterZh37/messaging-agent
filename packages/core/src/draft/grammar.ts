import type { ModelProvider } from "../models/types";

/**
 * Fix the grammar and nothing else (operator, 2026-09-25: "one quick button
 * for Fix Grammar and all it does is fix the grammatical errors in my email.
 * It doesn't change anything else, just fixes grammatical errors").
 *
 * The whole body comes back corrected rather than a list of replacements,
 * which is what the operator asked for; the risk in that is a model that
 * takes the invitation to rewrite. So what comes back is measured against
 * what went in, and a reply that has moved too far is refused rather than
 * dropped onto their card. Their words are theirs: a button that quietly
 * reworded them would be worse than no button.
 */

const MAX_TOKENS = 2000;

const RULES = `You are a proofreader. You fix grammar, spelling and punctuation in an email the operator has written, and you change nothing else.

Fix: verb agreement and tense, articles, plurals, prepositions, misspellings, capitalisation of names and sentence starts, punctuation, and a word used where a near-identical one is meant ("assist" where "assistance" is meant).

Never: reword a sentence that is already correct, change the tone, shorten or expand anything, reorder sentences, add or remove a sentence, add or remove a greeting or sign-off, change names, addresses, links, numbers, dates or amounts, or "improve" the style. British and American spellings are both correct: leave whichever they used.

Keep every line break exactly as it is, including blank lines. Keep any ** or __ marks around words exactly where they are: they carry the operator's emphasis.

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

/** Words, for comparing what came back with what went in. */
function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

/**
 * How much of the draft survived. A proofreader changes a word here and
 * there; a model that has rewritten the mail shows up as a body sharing far
 * less with the original. The share is of the original's words, so cutting
 * half the mail counts as much as replacing it.
 */
export function kept(before: string, after: string): number {
  const was = words(before);
  if (was.length === 0) return 1;
  const pool = new Map<string, number>();
  for (const w of words(after)) pool.set(w, (pool.get(w) ?? 0) + 1);
  let held = 0;
  for (const w of was) {
    const left = pool.get(w) ?? 0;
    if (left > 0) {
      held++;
      pool.set(w, left - 1);
    }
  }
  return held / was.length;
}

/** Below this, it is not a correction any more. Two words in three stay. */
export const KEEP_AT_LEAST = 0.66;

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

  // Some local models answer inside a fence, or with a line of preamble
  // before the mail; the body is what is wanted, not the wrapping.
  const answer = unwrap(result.text).trimEnd();
  if (answer === "") return { text: original, changed: false, refused: "The model answered with nothing." };

  const share = kept(original, answer);
  if (share < KEEP_AT_LEAST) {
    return { text: original, changed: false, refused: "That came back rewritten rather than corrected, so your draft is untouched." };
  }
  // A correction does not add or lose paragraphs. A line or two of drift is
  // the model tidying a ragged ending; more than that is a different mail.
  if (Math.abs(lineShape(answer) - lineShape(original)) > 2) {
    return { text: original, changed: false, refused: "That came back laid out differently, so your draft is untouched." };
  }

  return { text: answer, changed: answer !== original };
}

/** A fenced or quoted answer, unwrapped. */
function unwrap(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-z]*\n([\s\S]*?)\n?```$/i.exec(trimmed);
  if (fenced?.[1]) return fenced[1];
  return trimmed;
}
