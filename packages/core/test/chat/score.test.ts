import { describe, it, expect } from "vitest";
import { relevanceScore, explainScore, type ScoreParts } from "../../src/chat/score";

/**
 * The score the operator hovers (spec 2026-10-07, "when I hover over the
 * relevance score, it shows why the search results are what I'm asking for").
 * Its whole design constraint is that `explainScore` below has to be able to
 * say it out loud, so every test here is as much about the sentence as the
 * number.
 */

const DAY = 86_400_000;
const base = { ageMs: 30 * DAY, inSubject: false };
/** A distance at which the meaning half contributes nothing beyond having matched. */
const MEANING_FAR_ENOUGH = 1;

describe("relevanceScore", () => {
  it("scores a message both halves found above either alone", () => {
    const both = relevanceScore({ ...base, words: -9, meaning: 0.3 });
    expect(both).toBeGreaterThan(relevanceScore({ ...base, words: -9 }));
    expect(both).toBeGreaterThan(relevanceScore({ ...base, meaning: 0.3 }));
  });

  it("scores a strong word match above a weak one", () => {
    expect(relevanceScore({ ...base, words: -12 })).toBeGreaterThan(relevanceScore({ ...base, words: -2 }));
  });

  it("scores a near meaning match above a far one", () => {
    expect(relevanceScore({ ...base, meaning: 0.1 })).toBeGreaterThan(relevanceScore({ ...base, meaning: 0.9 }));
  });

  /** Recency is a nudge. A fresh irrelevant message must not outrank an old exact one. */
  it("never lets recency outrank a better match", () => {
    const old = relevanceScore({ ...base, words: -12, ageMs: 900 * DAY });
    const fresh = relevanceScore({ ...base, words: -2, ageMs: 0 });
    expect(old).toBeGreaterThan(fresh);
  });

  /**
   * bm25 is relative to the corpus: a term in every message carries no
   * information and scores near zero, which would show the operator a 0 beside
   * a message that contains exactly what they asked for. A match is worth
   * something for being a match.
   */
  it("never scores a real match at nothing, however common the word", () => {
    expect(relevanceScore({ ...base, words: 0 })).toBeGreaterThan(20);
    expect(relevanceScore({ ...base, meaning: MEANING_FAR_ENOUGH })).toBeGreaterThan(20);
  });

  it("still ranks a distinctive match far above a common one", () => {
    expect(relevanceScore({ ...base, words: -12 })).toBeGreaterThan(relevanceScore({ ...base, words: 0 }) + 20);
  });

  /**
   * bm25 is a sum over the query's terms, so it grows with how many words the
   * operator used. Measured against their own index: one term tops out near
   * -8.5, four terms near -14.8. A threshold calibrated on one term therefore
   * clamps every result of a four-word question to 100, and a column of
   * identical 100s is the exact problem the score exists to solve
   * (whole-branch review, 2026-10-07).
   */
  it("does not saturate when the operator asks in a sentence", () => {
    // `words` is per-term, so a four-word question whose terms are individually
    // ordinary scores like an ordinary match, not like a perfect one.
    const longQuestion = relevanceScore({ ...base, words: -14.82 / 4 });
    expect(longQuestion).toBeLessThan(90);
    expect(longQuestion).toBeGreaterThan(40);
  });

  /** The bonus for two kinds of evidence must survive a strong word match. */
  it("still scores both halves above either alone at the top of the range", () => {
    const both = relevanceScore({ ...base, words: -20, meaning: 0.0 });
    expect(both).toBeGreaterThan(relevanceScore({ ...base, words: -20 }));
    expect(both).toBeGreaterThan(relevanceScore({ ...base, meaning: 0.0 }));
  });

  /**
   * The distances are L2 over unit-normalised vectors, not cosine, and a real
   * question's nearest neighbours sit far further out than the constant
   * assumed. Measured through Ollama against the operator's own 94k-message
   * index, five real questions, top eight each: every distance fell between
   * 0.69 and 0.93 — which under the old scale put every meaning hit at 38 to
   * 49, so semantic search was permanently marked weak (review, 2026-10-07).
   */
  it("lets the best meaning match clear the strong threshold", () => {
    expect(relevanceScore({ ...base, meaning: 0.69 })).toBeGreaterThanOrEqual(70);
  });

  it("still calls a distant neighbour weak", () => {
    expect(relevanceScore({ ...base, meaning: 0.93 })).toBeLessThan(70);
  });

  it("spreads the band real questions actually produce", () => {
    const near = relevanceScore({ ...base, meaning: 0.69 });
    const far = relevanceScore({ ...base, meaning: 0.93 });
    expect(near - far).toBeGreaterThan(20);
  });

  it("is a whole number between 0 and 100 whatever it is given", () => {
    const wild: ScoreParts[] = [
      { ...base, words: -999 },
      { ...base, meaning: 99 },
      { ...base, words: 0 },
      { ...base, meaning: -5 },
      base,
    ];
    for (const p of wild) {
      const s = relevanceScore(p);
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }
  });
});

describe("explainScore", () => {
  /** The normal state during the backfill: no vector yet, so only the words contributed. */
  it("names only the parts that contributed", () => {
    const said = explainScore({ ...base, words: -9, matched: ["job", "training"] });
    expect(said).toMatch(/job training/);
    expect(said).not.toMatch(/meaning/i);
  });

  it("says when both halves found it, because that is the strongest signal", () => {
    expect(explainScore({ ...base, words: -9, meaning: 0.3, matched: ["invoice"] })).toMatch(/both/i);
  });

  it("says where the words matched when they were in the subject", () => {
    expect(explainScore({ ...base, words: -9, inSubject: true, matched: ["invoice"] })).toMatch(/subject/i);
  });

  it("reads as a sentence when only the meaning matched", () => {
    const said = explainScore({ ...base, meaning: 0.2 }, ["billing"]);
    expect(said).toMatch(/close in meaning/i);
    expect(said).not.toMatch(/^Matched/);
    expect(said.endsWith(".")).toBe(true);
  });

  /**
   * `words === undefined` means the keyword half did not return it, not that
   * the operator's words are absent from it — a question over three terms does
   * no OR fallback at all, so a meaning-only hit can plainly contain them
   * (whole-branch review, 2026-10-07).
   */
  it("never claims the operator's words are absent, only that the words half did not find it", () => {
    expect(explainScore({ ...base, meaning: 0.2 }, ["invoice"])).not.toMatch(/not in it/i);
  });

  /** Under the OR fallback a hit needs one term, so naming them all as a phrase is a lie. */
  it("names only the terms it was told actually matched", () => {
    const said = explainScore({ ...base, words: -9, matched: ["invoice"] }, ["invoice", "acme", "march"]);
    expect(said).toMatch(/invoice/);
    expect(said).not.toMatch(/acme/);
  });

  it("falls back to saying 'your words' when it was not told which matched", () => {
    expect(explainScore({ ...base, words: -9 }, ["invoice", "acme", "march"])).toMatch(/your words/i);
  });

  it("always says how old it is, since that is always a part", () => {
    expect(explainScore({ ...base, words: -9, ageMs: 3 * DAY }, ["invoice"])).toMatch(/3 days ago/);
    expect(explainScore({ ...base, words: -9, ageMs: 0 }, ["invoice"])).toMatch(/today/i);
  });

  /** A citation Celeste read from a thread was never ranked; the sentence says so. */
  it("says plainly when nothing ranked it at all", () => {
    expect(explainScore(base, ["invoice"])).toMatch(/not from a search/i);
  });
});
