import { describe, it, expect } from "vitest";
import { encodeHeaderWord, replySubject, validateRecipients } from "../../src/connectors/mime";

describe("replySubject", () => {
  it("prefixes Re: once", () => {
    expect(replySubject("Lunch")).toBe("Re: Lunch");
    expect(replySubject("Re: Lunch")).toBe("Re: Lunch");
    expect(replySubject("RE: Lunch")).toBe("RE: Lunch");
    expect(replySubject("")).toBe("Re: ");
  });
});

describe("validateRecipients", () => {
  it("accepts plain addresses in To and Cc", () => {
    expect(() => validateRecipients(["bob@x.com"], ["carol@x.com"])).not.toThrow();
  });

  it("rejects header injection via a recipient", () => {
    expect(() => validateRecipients(["bob@x.com\nBcc: evil@x.com"], [])).toThrow();
  });

  it("rejects an implausible recipient address", () => {
    expect(() => validateRecipients(["not an address"], [])).toThrow(/invalid recipient/);
    expect(() => validateRecipients([], ["two@@at.com"])).toThrow(/invalid recipient/);
  });
});

describe("encodeHeaderWord", () => {
  it("leaves an ASCII value literal", () => {
    expect(encodeHeaderWord("Re: Lunch")).toBe("Re: Lunch");
  });

  it("encodes a non-ASCII value as RFC 2047 UTF-8 base64", () => {
    const subject = "Re: Café ☕";
    const encoded = encodeHeaderWord(subject);
    expect(encoded).toMatch(/^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/);
    const b64 = encoded.slice("=?UTF-8?B?".length, -"?=".length);
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(subject);
  });

  it("rejects a value with a line break", () => {
    expect(() => encodeHeaderWord("Re: X\r\nBcc: evil@x.com")).toThrow();
  });
});
