import { describe, it, expect } from "vitest";
import { parseBlocklist, isBlocked, normalizeAddress, loadBlocklist } from "../src/blocklist";

describe("blocklist", () => {
  it("parses emails and phones, ignoring comments and blanks", () => {
    const list = parseBlocklist("# header\nSpam@Example.com\n\n+1 (415) 555-0100  # note\n");
    expect(list.has("spam@example.com")).toBe(true);
    expect(list.has("+14155550100")).toBe(true);
    expect(list.size).toBe(2);
  });

  it("normalizes case and phone punctuation", () => {
    expect(normalizeAddress("  Bob@X.com ")).toBe("bob@x.com");
    expect(normalizeAddress("415-555-0100")).toBe("4155550100");
  });

  it("matches blocked senders", () => {
    const list = parseBlocklist("spam@example.com");
    expect(isBlocked(list, "SPAM@example.com")).toBe(true);
    expect(isBlocked(list, "friend@example.com")).toBe(false);
  });

  it("returns empty set for a missing file", async () => {
    expect((await loadBlocklist("/nonexistent/blocklist.txt")).size).toBe(0);
  });
});
