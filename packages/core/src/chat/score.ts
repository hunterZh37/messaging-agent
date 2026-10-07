/**
 * How relevant a hit is, as a number the operator can argue with (operator,
 * 2026-10-07: "I have a relevance score and when I hover over the relevance
 * score, it shows why the search results are what I'm asking for").
 *
 * The constraint that shapes all of this: the hover explains the score, so
 * every part of the number has to be nameable in a sentence. That rules out a
 * fitted blend of weights — nobody can read one of those out loud. So it is
 * four things, each of which `explainScore` below can say.
 *
 * The weights are a stated guess. They cannot be measured until the scores can
 * be seen against real questions, which is what this builds; expect them to
 * move once the operator has looked at a week of them.
 */
export interface ScoreParts {
  /** `bm25()` from the keyword index: negative, and more negative is better. Absent when the words half did not find it. */
  words?: number;
  /** Cosine distance from the vector table: 0 is identical. Absent when the meaning half did not find it. */
  meaning?: number;
  /** How long ago it was sent. */
  ageMs: number;
  /** Whether any of the operator's words are in the subject, which is worth saying out loud. */
  inSubject: boolean;
}

/**
 * A bm25 at or beyond this counts as a full-strength word match. Measured
 * against the operator's own mailbox: the best hit for a common term sits
 * near -9, so 12 leaves room above what real mail produces.
 */
const WORDS_FULL = 12;

/** A cosine distance at or beyond this counts as no meaning match at all. */
const MEANING_FAR = 1;

/** What two independent kinds of evidence agreeing is worth. */
const BOTH_BONUS = 0.15;

/** The most recency can add. A nudge: it must never carry a weak match past a strong one. */
const RECENCY_NUDGE = 0.05;

/** Recency has faded to nothing by here. */
const RECENCY_SPAN_MS = 90 * 86_400_000;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** The words half's contribution, 0 to 1. */
function wordsPart(bm25: number | undefined): number | undefined {
  if (bm25 === undefined) return undefined;
  // bm25 is negative and better the lower it goes; flip it so bigger is better.
  return clamp01(-bm25 / WORDS_FULL);
}

/** The meaning half's contribution, 0 to 1. */
function meaningPart(distance: number | undefined): number | undefined {
  if (distance === undefined) return undefined;
  return clamp01(1 - distance / MEANING_FAR);
}

export function relevanceScore(parts: ScoreParts): number {
  const w = wordsPart(parts.words);
  const m = meaningPart(parts.meaning);
  // The better half leads, and a message both halves found takes a bonus on
  // top — not the average of the two, which would punish a message one half
  // was merely lukewarm about. Two kinds of evidence agreeing is the strongest
  // thing this system knows about a message.
  const best = Math.max(w ?? 0, m ?? 0);
  const both = w !== undefined && m !== undefined ? BOTH_BONUS : 0;
  const fresh = RECENCY_NUDGE * clamp01(1 - parts.ageMs / RECENCY_SPAN_MS);
  return Math.round(100 * clamp01(best + both + fresh));
}

/** "3 days ago", or "today" for anything inside a day. */
function age(ageMs: number): string {
  const days = Math.floor(ageMs / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 60) return `${days} days ago`;
  return `${Math.round(days / 30)} months ago`;
}

/**
 * Why this message scored what it did, in the operator's own terms. Names only
 * the parts that actually contributed: during the backfill most mail has no
 * vector yet, and a sentence claiming a meaning match where there was none
 * would be worse than no sentence at all.
 */
export function explainScore(parts: ScoreParts, terms: string[]): string {
  const quoted = terms.length > 0 ? `“${terms.join(" ")}”` : "your words";
  const where = parts.inSubject ? " in the subject" : "";
  let lead: string;
  if (parts.words !== undefined && parts.meaning !== undefined) {
    lead = `Found both ways: ${quoted} appear in it${where}, and it is close in meaning to what you asked`;
  } else if (parts.words !== undefined) {
    lead = `Matched ${quoted}${where}`;
  } else if (parts.meaning !== undefined) {
    lead = `Close in meaning to what you asked, though ${quoted} are not in it`;
  } else {
    // Celeste cites what she read as well as what she searched for; a message
    // nobody ranked gets no score, and this says why rather than implying one.
    lead = "Cited from what was already open, not from a search";
  }
  return `${lead}; sent ${age(parts.ageMs)}.`;
}
