/**
 * The little emphasis a reply is allowed (operator, 2026-09-20: "when Celeste
 * drafts email, should also bold or underline words that are important").
 *
 * Two marks and no more: `**bold**` and `__underline__`. They live inside the
 * draft's own text rather than in a second column, which is what keeps revise,
 * the undo stack and the change diff working: a draft is still one string, and
 * every one of those reads it as one.
 *
 * Mail goes out with both parts, the HTML for readers who get HTML and the
 * marks stripped for everyone else, so nobody is ever shown the asterisks.
 */

/** What the drafter is told. One line, because a rule about emphasis that runs to a paragraph gets ignored. */
export const MARKUP_RULE = `- Emphasis is rationed. Wrap **bold** around the one thing the reader must not miss, a date, an amount, a decision, and __underline__ around a deadline. Two or three marks in a whole reply is plenty. A reply with nothing urgent in it carries none, and never mark a greeting, a sign off, or a whole sentence.`;

/** Marks stripped: what a plain reader sees, and what a chat is sent. */
export function stripMarkup(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/gs, "$1").replace(/__(.+?)__/gs, "$1");
}

/** Whether there is anything here that would render differently. */
export function hasMarkup(text: string): boolean {
  return /\*\*(.+?)\*\*/s.test(text) || /__(.+?)__/s.test(text);
}

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The HTML part of an outgoing reply.
 *
 * Escaped first and marked up after, so a draft that mentions `<div>` says
 * `<div>` at the other end rather than making one. A blank line is a new
 * paragraph and a single newline is a line break, which is how the text part
 * already reads to a person.
 */
export function markupToHtml(text: string): string {
  const paragraphs = text.split(/\n{2,}/).map((block) =>
    escape(block)
      .replace(/\*\*(.+?)\*\*/gs, "<strong>$1</strong>")
      .replace(/__(.+?)__/gs, "<u>$1</u>")
      .replace(/\n/g, "<br>"),
  );
  return paragraphs.filter((p) => p.length > 0).map((p) => `<p>${p}</p>`).join("\n");
}

/** One mark's spans in a string, for an editor that has to draw them. */
export interface MarkupSpan {
  text: string;
  bold: boolean;
  underline: boolean;
}

/**
 * The draft as spans, so the card can show emphasis where the textarea shows
 * marks. Nesting is not supported on purpose: `**__both__**` is a thing a
 * person types by accident far more often than on purpose, and one level is
 * the whole of what the rule above asks for.
 */
export function markupSpans(text: string): MarkupSpan[] {
  const out: MarkupSpan[] = [];
  const pattern = /\*\*(.+?)\*\*|__(.+?)__/gs;
  let at = 0;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), bold: false, underline: false });
    out.push({ text: m[1] ?? m[2] ?? "", bold: m[1] !== undefined, underline: m[2] !== undefined });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), bold: false, underline: false });
  return out;
}
