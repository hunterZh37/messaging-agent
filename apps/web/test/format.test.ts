import { describe, it, expect } from "vitest";
import { relativeTime } from "../lib/format";
import { channelGlyph, cleanSnippet, invalidAddresses, sendBlockFor } from "../lib/format";

describe("relativeTime", () => {
  const now = Date.UTC(2026, 8, 9, 18, 0, 0);
  it("says just now under a minute", () => expect(relativeTime(now - 20_000, now)).toBe("just now"));
  it("counts minutes, then hours", () => {
    expect(relativeTime(now - 4 * 60_000, now)).toBe("4 min ago");
    expect(relativeTime(now - 2 * 3_600_000, now)).toBe("2 h ago");
  });
  it("falls back to a date after a day", () => expect(relativeTime(now - 3 * 86_400_000, now)).toMatch(/Sep/));
  it("never goes negative for a clock slightly ahead", () => expect(relativeTime(now + 5_000, now)).toBe("just now"));
});

describe("invalidAddresses", () => {
  it("names what cannot be sent to and lets real addresses through", () => {
    expect(invalidAddresses(["a@b.co", "nope", "two@@x.com", "trailing@", "@lead", "sp ace@x.com"])).toEqual(["nope", "two@@x.com", "trailing@", "@lead", "sp ace@x.com"]);
    expect(invalidAddresses([])).toEqual([]);
  });
});

describe("sendBlockFor", () => {
  it("names what holds a send back, in the order the operator would fix it", () => {
    expect(sendBlockFor("hi", [], [])).toBe("Needs someone in To.");
    expect(sendBlockFor("hi", ["nope"], [])).toBe("Not an address: nope");
    expect(sendBlockFor("hi", ["a@b.co"], ["bad"])).toBe("Not an address: bad");
    expect(sendBlockFor("  \n ", ["a@b.co"], [])).toBe("The reply is empty.");
    expect(sendBlockFor("hi", ["a@b.co"], [])).toBeUndefined();
    // A text goes to a phone number, which is no mail address.
    expect(sendBlockFor("hi", ["+14155550122"], [], "text")).toBeUndefined();
    expect(sendBlockFor("hi", [], [], "text")).toBe("Needs someone in To.");
  });
});

describe("cleanSnippet", () => {
  it("drops the invisible preheader padding and folds the whitespace", () => {
    // Stress loop, 2026-09-11: an Amazon snippet trailed forty of them.
    expect(cleanSnippet("Delivered 2 items: Snack Foods\u034f \u200c \u00ad\u034f \u200c   \u00ad")).toBe("Delivered 2 items: Snack Foods");
    expect(cleanSnippet(null)).toBe("");
  });
});

describe("channelGlyph", () => {
  it("gives texts the app they came from, and mail the envelope (operator, 2026-09-11)", () => {
    expect(channelGlyph("imessage")).toBe("apple");
    expect(channelGlyph("whatsapp")).toBe("whatsapp");
    expect(channelGlyph("imap")).toBe("mail");
    expect(channelGlyph("outlook")).toBe("mail");
  });
});
