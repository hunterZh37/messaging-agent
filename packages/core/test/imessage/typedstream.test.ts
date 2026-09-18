import { describe, it, expect } from "vitest";
import { decodeAttributedBody } from "../../src/imessage/typedstream";

// Real prefixes from a macOS 26 chat.db (2026-09-11), text bytes replaced by the sample shown.
const PREFIX = Buffer.from("040b73747265616d747970656481e803840140848484124e5341747472696275746564537472696e67008484084e534f626a656374008592848484084e53537472696e67019484012b", "hex");
const TAIL = Buffer.from("8684026949010892848484", "hex");

function body(text: string): Buffer {
  const bytes = Buffer.from(text, "utf8");
  const len = bytes.length < 0x80 ? Buffer.from([bytes.length]) : bytes.length < 0x10000 ? Buffer.concat([Buffer.from([0x81]), Buffer.from([bytes.length & 0xff, bytes.length >> 8])]) : Buffer.concat([Buffer.from([0x82]), Buffer.from(new Uint32Array([bytes.length]).buffer)]);
  return Buffer.concat([PREFIX, len, bytes, TAIL]);
}

describe("decodeAttributedBody", () => {
  it("reads a short text, an emoji, and a long one with a two-byte length", () => {
    expect(decodeAttributedBody(body("So cute "))).toBe("So cute");
    expect(decodeAttributedBody(body("😻😻"))).toBe("😻😻");
    const long = "Thank you for choosing Brother Movers. ".repeat(80);
    expect(decodeAttributedBody(body(long))).toBe(long.trim());
  });

  it("is null for an attachment-only bubble and for bytes that are not a typedstream", () => {
    expect(decodeAttributedBody(body("￼"))).toBeNull();
    expect(decodeAttributedBody(Buffer.from("not a stream"))).toBeNull();
    expect(decodeAttributedBody(null)).toBeNull();
  });
});
