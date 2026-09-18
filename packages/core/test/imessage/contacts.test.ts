import { describe, it, expect } from "vitest";
import { normalizeHandle } from "../../src/imessage/contacts";

describe("normalizeHandle", () => {
  it("matches a formatted number to the handle chat.db keeps", () => {
    expect(normalizeHandle("(415) 555-0100")).toBe("4155550100");
    expect(normalizeHandle("+1 415 555 0100")).toBe("4155550100");
    expect(normalizeHandle("+14155550100")).toBe("4155550100");
  });
  it("lower-cases an email and leaves short codes alone", () => {
    expect(normalizeHandle("Someone@Example.com")).toBe("someone@example.com");
    expect(normalizeHandle("76934")).toBe("76934");
  });
});

describe("addressBookFiles without access", () => {
  it("returns what it can read instead of throwing (2026-09-15)", async () => {
    const { addressBookFiles } = await import("../../src/imessage/contacts");
    expect(addressBookFiles("/nonexistent-celeste-test-dir")).toEqual([]);
  });
});
