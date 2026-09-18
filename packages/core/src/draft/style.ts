/**
 * How the operator wants Celeste to write (2026-09-10): "I do not want to
 * use semicolons, hyphens, or em dashes. I want to sound more like a human."
 * The rule goes into every prompt that produces mail, and the text that
 * comes back is tidied once more, because a model that has been told not to
 * reach for a dash still does now and then.
 */
export const HUMAN_STYLE_RULE = `- Write like a person, not a document. No semicolons. No em dashes or en dashes, and no hyphens used as dashes between words; a hyphen inside a word (follow-up, well-known) is fine. Where you would have used one of those, write two sentences or use a comma. Plain, warm, direct.`;

/**
 * The same rule applied after the fact: a dash used as punctuation becomes
 * a comma, a semicolon becomes a full stop and the next word starts a new
 * sentence. Hyphens inside words are left alone.
 */
export function humanizePunctuation(text: string): string {
  return (
    text
      // A dash that ends a line is dropped; elsewhere " — ", " – ", "—",
      // "–" and a spaced " - " all mean "dash here".
      .replace(/[ \t]*[—–][ \t]*(?=\n|$)/g, "")
      .replace(/[ \t]*[—–][ \t]*/g, ", ")
      .replace(/(\S)\s+-\s+(\S)/g, "$1, $2")
      // A comma that landed before another stop, or at a line end, is noise.
      .replace(/,\s*([,.!?:])/g, "$1")
      .replace(/,\s*(\n|$)/g, "$1")
      // "; " splits the sentence; the next word takes a capital.
      .replace(/;\s*(\S)/g, (_m, c: string) => `. ${c.toUpperCase()}`)
      .replace(/;/g, ".")
  );
}
