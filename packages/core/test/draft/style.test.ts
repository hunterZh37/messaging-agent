import { describe, it, expect } from "vitest";
import { HUMAN_STYLE_RULE, humanizePunctuation } from "../../src/draft/style";

describe("humanizePunctuation", () => {
  it("turns dashes used as punctuation into commas and leaves hyphenated words alone", () => {
    expect(humanizePunctuation("Good catch — I'll reach out to Ryan – and let you know.")).toBe("Good catch, I'll reach out to Ryan, and let you know.");
    expect(humanizePunctuation("A quick follow-up on the well-known issue - it is fixed.")).toBe("A quick follow-up on the well-known issue, it is fixed.");
  });

  it("splits a semicolon into two sentences", () => {
    expect(humanizePunctuation("Thanks for the draft; it reads well.")).toBe("Thanks for the draft. It reads well.");
  });

  it("does not leave a comma before a stop or at a line end", () => {
    expect(humanizePunctuation("See below —\nThanks.")).toBe("See below\nThanks.");
    expect(humanizePunctuation("Done —.")).toBe("Done.");
  });

  it("names the rule for the prompts", () => {
    expect(HUMAN_STYLE_RULE).toContain("No semicolons");
    expect(HUMAN_STYLE_RULE).toContain("em dashes");
  });
});
