/**
 * The text of an iMessage, out of Apple's `attributedBody` (2026-09-11).
 *
 * Since macOS Ventura the `text` column of `message` is mostly empty and
 * the body sits in `attributedBody`, an NSKeyedArchiver "typedstream" of an
 * NSAttributedString. The layout is stable enough to read without a full
 * typedstream parser: the class name `NSString` is followed by the bytes
 * `01 94 84 01 2B`, then a length, then the UTF-8 text. The length is one
 * byte under 0x80, or 0x81 followed by a little-endian 16-bit count, or
 * 0x82 followed by a little-endian 32-bit count. Everything after the text
 * is attribute runs (fonts, link ranges) and is not needed.
 */
const MARKER = Buffer.from("NSString");
const PLUS = 0x2b;

export function decodeAttributedBody(body: Buffer | Uint8Array | null | undefined): string | null {
  if (!body || body.length === 0) return null;
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const at = buf.indexOf(MARKER);
  if (at < 0) return null;
  // The `+` that opens the string's length is within a few bytes of the class name.
  let plus = -1;
  for (let i = at + MARKER.length; i < Math.min(buf.length, at + MARKER.length + 12); i++) {
    if (buf[i] === PLUS) {
      plus = i;
      break;
    }
  }
  if (plus < 0 || plus + 1 >= buf.length) return null;
  const head = buf[plus + 1]!;
  let length: number;
  let start: number;
  if (head === 0x81) {
    if (plus + 4 > buf.length) return null;
    length = buf.readUInt16LE(plus + 2);
    start = plus + 4;
  } else if (head === 0x82) {
    if (plus + 6 > buf.length) return null;
    length = buf.readUInt32LE(plus + 2);
    start = plus + 6;
  } else if (head < 0x80) {
    length = head;
    start = plus + 2;
  } else {
    return null;
  }
  if (start + length > buf.length) return null;
  const text = buf.subarray(start, start + length).toString("utf8");
  // U+FFFC is the placeholder Messages leaves where an attachment sat.
  return text.replace(/￼/g, "").trim() || null;
}
