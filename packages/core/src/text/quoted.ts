/**
 * Where a reply stops being the sender's own words: the first "On … wrote:"
 * attribution, a forwarded header block, an Outlook separator, or a quoted
 * line. Anything from there down belongs to whoever wrote it first.
 */
// `From:` with nothing after it is a header block too: senders whose client
// puts the name in its own element leave the label alone on its line, and
// requiring text after it left the whole history in the message.
const CUT = [/^On .+ wrote:$/, /^From:/, /^-----Original Message-----/, /^>/];

/**
 * The part of a mail body its sender actually typed. Quoted history is
 * dropped, because a question in the mail being answered says nothing about
 * whether this message asks one (spec 10a, "Waiting for reply").
 */
export function stripQuoted(text: string): string {
  return splitQuoted(text).own;
}

/**
 * A plain-text body in two parts: what its sender typed, and the history they
 * replied over. The thread view shows the first and folds the second, because
 * every message in a six-message exchange carries the five before it and
 * reading them six times is not reading a conversation (spec 10a). This module
 * is exported as `@messaging-agent/core/text` so the browser can use it
 * without the database coming along.
 */
export function splitQuoted(text: string): { own: string; quoted: string } {
  const lines = text.split(/\r?\n/);
  const cut = lines.findIndex((line) => CUT.some((re) => re.test(line.trim())));
  if (cut === -1) return { own: text.trim(), quoted: "" };
  return { own: lines.slice(0, cut).join("\n").trim(), quoted: lines.slice(cut).join("\n").trim() };
}

/** Request phrasing that asks for something without a question mark. */
const REQUEST =
  /\b(please|could you|can you|would you|let me know|kindly|confirm|send me|get back to me|thoughts\?|when (can|could|would)|what do you think)\b/i;

/**
 * Does this text ask the other side for something? The heuristic behind
 * "Waiting for reply" (spec 10a): a question mark, or a request phrase. No
 * model call — a sent-mail folder is far too big to pay one per message.
 */
export function asksSomething(text: string): boolean {
  return text.includes("?") || REQUEST.test(text);
}
