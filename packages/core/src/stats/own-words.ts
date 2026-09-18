/**
 * What the operator actually wrote, with everybody else's words taken back
 * out (operator, 2026-09-17).
 *
 * A sent mail carries the thread under it. In this mailbox the operator's own
 * mail averages 2,198 characters against 39 for a chat message, and a quarter
 * of it quotes somebody else, so a sample drawn straight from `body_text`
 * would be mostly other people and would be read as the operator. Anything
 * that describes how they write has to start here.
 */

/**
 * Lines that begin a quoted section. Everything from the first of these to the
 * end of the body belongs to somebody else, or is a header about them.
 */
const CUTS: RegExp[] = [
  /^On .{0,200}wrote:\s*$/im,
  /^-{2,}\s*Original Message\s*-{2,}\s*$/im,
  /^_{10,}\s*$/m,
  /^From:\s.+$/im,
  /^Sent from my \w+/im,
  /^Get Outlook for \w+/im,
];

/**
 * The operator's own words from one message body: quoted thread removed,
 * newlines flattened, and cut to `cap` so one long mail cannot crowd out a
 * month of short chat messages in a sample.
 *
 * Returns null when nothing is left worth reading, which is what a bare "ok",
 * a reaction or an empty body comes to.
 */
export function ownWords(body: string | null, cap = 300): string | null {
  if (!body) return null;
  let text = body;
  for (const cut of CUTS) {
    const at = text.search(cut);
    if (at !== -1) text = text.slice(0, at);
  }
  const kept = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (kept.length < 2) return null;
  return kept.length > cap ? `${kept.slice(0, cap).trimEnd()}…` : kept;
}
