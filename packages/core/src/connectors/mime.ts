/** Prefixes "Re: " once, whatever case the original subject used. */
export function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

function headerValue(s: string): string {
  if (/[\r\n]/.test(s)) throw new Error("header value contains a line break");
  return s;
}

/** RFC 2047 encodes a header word only when it carries non-ASCII characters. */
export function encodeHeaderWord(s: string): string {
  headerValue(s);
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) >= 0x80) return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
  }
  return s;
}

function validateAddress(addr: string): string {
  headerValue(addr);
  const atCount = (addr.match(/@/g) ?? []).length;
  if (atCount !== 1 || /\s/.test(addr)) throw new Error(`invalid recipient: ${addr}`);
  return addr;
}

/** Validates every To/Cc address. Shared by every provider's send path so bad addresses are caught before hitting the network, regardless of transport. */
export function validateRecipients(to: string[], cc: string[]): void {
  to.forEach(validateAddress);
  cc.forEach(validateAddress);
}
