import { describe, it, expect } from "vitest";
import {
  celesteBlockFor,
  composeBlockFor,
  firstContactLabel,
  humanizeComposePunctuation,
  parseAddressList,
  replaceToken,
  tokenAtCaret,
} from "../lib/compose";

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

describe("tokenAtCaret", () => {
  it("finds the run between the commas either side of the caret", () => {
    const list = "ana@example.com, bo@example.com, cy@example.com";
    // Caret in the middle of "bo@example.com".
    expect(tokenAtCaret(list, list.indexOf("bo") + 2)).toEqual({
      start: list.indexOf(", bo") + 1,
      end: list.indexOf(", cy"),
      query: "bo@example.com",
    });
  });

  it("treats a trailing comma as an empty token ready for the next address", () => {
    const list = "ana@example.com, ";
    expect(tokenAtCaret(list, list.length)).toEqual({ start: list.indexOf(", ") + 1, end: list.length, query: "" });
  });

  it("trims the spaces around a token out of the query", () => {
    const list = "ana@example.com,   bo  ,cy@example.com";
    expect(tokenAtCaret(list, list.indexOf("bo"))).toEqual({
      start: list.indexOf(",  ") + 1,
      end: list.lastIndexOf(","),
      query: "bo",
    });
  });

  it("is the whole field when there is a single token", () => {
    expect(tokenAtCaret("ana", 2)).toEqual({ start: 0, end: 3, query: "ana" });
  });

  it("is empty for an empty field", () => {
    expect(tokenAtCaret("", 0)).toEqual({ start: 0, end: 0, query: "" });
  });
});

describe("replaceToken", () => {
  it("swaps the token under the caret and leaves the rest of the list alone", () => {
    const list = "ana@example.com, bo@example.com, cy@example.com";
    const caret = list.indexOf("bo") + 2;
    const result = replaceToken(list, caret, "robert@example.com");
    expect(result.value).toBe("ana@example.com, robert@example.com, cy@example.com");
    expect(result.value.slice(result.caret)).toBe(", cy@example.com");
  });

  it("adds a comma and space after the last token, ready for the next one", () => {
    const result = replaceToken("ana@example.com, b", "ana@example.com, b".length, "bo@example.com");
    expect(result.value).toBe("ana@example.com, bo@example.com, ");
    expect(result.caret).toBe(result.value.length);
  });

  it("fills a trailing comma's empty slot without losing the space before it", () => {
    const list = "ana@example.com, ";
    const result = replaceToken(list, list.length, "bo@example.com");
    expect(result.value).toBe("ana@example.com, bo@example.com, ");
  });

  it("fills the whole field when it holds a single token", () => {
    const result = replaceToken("bo", 2, "bo@example.com");
    expect(result.value).toBe("bo@example.com, ");
  });

  it("fills an empty field", () => {
    const result = replaceToken("", 0, "bo@example.com");
    expect(result.value).toBe("bo@example.com, ");
    expect(result.caret).toBe(result.value.length);
  });

  it("replaces a token that is already a full address", () => {
    const result = replaceToken("bo@example.com", 5, "robert@example.com");
    expect(result.value).toBe("robert@example.com, ");
  });
});

describe("firstContactLabel", () => {
  it("names every new recipient in full, and is null when nobody is new", () => {
    expect(firstContactLabel([])).toBeNull();
    expect(firstContactLabel(["a@example.com"])).toBe("First message ever sent to this address: a@example.com");
    expect(firstContactLabel(["a@example.com", "b@example.com"])).toBe("First message ever sent to these addresses: a@example.com, b@example.com");
  });
});
