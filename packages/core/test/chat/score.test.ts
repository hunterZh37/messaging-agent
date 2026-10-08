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
    const said = explainScore({ ...base, words: -9 }, ["job", "training"]);
    expect(said).toMatch(/job training/);
    expect(said).not.toMatch(/meaning/i);
  });

  it("says when both halves found it, because that is the strongest signal", () => {
    expect(explainScore({ ...base, words: -9, meaning: 0.3 }, ["invoice"])).toMatch(/both/i);
  });

  it("says where the words matched when they were in the subject", () => {
    expect(explainScore({ ...base, words: -9, inSubject: true }, ["invoice"])).toMatch(/subject/i);
  });

  it("reads as a sentence when only the meaning matched", () => {
    const said = explainScore({ ...base, meaning: 0.2 }, ["billing"]);
    expect(said).toMatch(/close in meaning/i);
    expect(said).not.toMatch(/^Matched/);
    expect(said.endsWith(".")).toBe(true);
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
