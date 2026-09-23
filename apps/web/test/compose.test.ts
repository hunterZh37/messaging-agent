import { describe, it, expect } from "vitest";
import { celesteBlockFor, composeBlockFor, firstContactLabel, humanizeComposePunctuation, parseAddressList } from "../lib/compose";

describe("parseAddressList", () => {
  it("splits on commas and whitespace, lowercases, and drops the empties", () => {
    expect(parseAddressList("a@example.com, b@example.com  c@example.com")).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
    expect(parseAddressList("A@Example.com")).toEqual(["a@example.com"]);
    expect(parseAddressList("  ")).toEqual([]);
  });
});

describe("composeBlockFor", () => {
  const ok = { accountId: "acct1", to: ["a@example.com"], cc: [], subject: "Hello" };
  it("names what holds the composer back, in the order the operator would fix it", () => {
    expect(composeBlockFor({ ...ok, accountId: "" })).toBe("Pick an account to send from.");
    expect(composeBlockFor({ ...ok, to: [] })).toBe("Needs someone in To.");
    expect(composeBlockFor({ ...ok, to: ["nope"] })).toBe("Not an address: nope");
    expect(composeBlockFor({ ...ok, cc: ["bad"] })).toBe("Not an address: bad");
    expect(composeBlockFor({ ...ok, subject: "  " })).toBe("Needs a subject.");
    expect(composeBlockFor(ok)).toBeUndefined();
  });
});

describe("celesteBlockFor", () => {
  it("needs the one line before Celeste can draft anything", () => {
    expect(celesteBlockFor("")).toBe("Say what the email should tell them.");
    expect(celesteBlockFor("   ")).toBe("Say what the email should tell them.");
    expect(celesteBlockFor("ask about the invoice")).toBeUndefined();
  });
});

describe("humanizeComposePunctuation", () => {
  it("turns dashes and semicolons into the operator's plain punctuation", () => {
    expect(humanizeComposePunctuation("today — tomorrow")).toBe("today, tomorrow");
    expect(humanizeComposePunctuation("done for now —")).toBe("done for now");
    expect(humanizeComposePunctuation("here now; there later")).toBe("here now. There later");
    expect(humanizeComposePunctuation("a - b")).toBe("a, b");
    // A hyphen inside a word is not a dash and is left alone.
    expect(humanizeComposePunctuation("a follow-up email")).toBe("a follow-up email");
  });
});

describe("firstContactLabel", () => {
  it("names every new recipient in full, and is null when nobody is new", () => {
    expect(firstContactLabel([])).toBeNull();
    expect(firstContactLabel(["a@example.com"])).toBe("First message ever sent to this address: a@example.com");
    expect(firstContactLabel(["a@example.com", "b@example.com"])).toBe("First message ever sent to these addresses: a@example.com, b@example.com");
  });
});
