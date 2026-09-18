/**
 * The named entities real mail actually uses. Zero-width joiners, non-joiners
 * and soft hyphens map to nothing: they are invisible spacing, not content,
 * and marketing mail pads with them by the dozen.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  zwnj: "",
  zwj: "",
  shy: "",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
};

/** Decodes numeric and known named entities. Anything unrecognised is left exactly as written. */
function decodeEntities(text: string): string {
  return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/**
 * Turns an HTML mail body into readable plain text. Provider-neutral: used by
 * the IMAP and Graph normalizers alike. Entities are decoded after the tags
 * are gone, so a decoded angle bracket is never mistaken for markup.
 */
/**
 * The characters mail senders hide in preheaders to pad the inbox preview
 * (zero-width joiners, soft hyphens, combining graphemes, byte-order marks).
 * They carry no text and render as odd blank runs (stress loop, 2026-09-11:
 * an Amazon snippet trailed forty of them).
 */
const INVISIBLE = /[\u034F\u00AD\u200B-\u200D\u2060\uFEFF]/g;

export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE, "");
}

export function stripHtml(html: string): string {
  const text = decodeEntities(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n\n")
      .replace(/<[^>]+>/g, ""),
  );

  return stripInvisible(text)
    .replace(/[^\S\n]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
