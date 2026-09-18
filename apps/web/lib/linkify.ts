/**
 * Plain-text mail carries its links as bare URLs, often the 200-character
 * tracking kind, and the text they belong to sits right before them:
 * `[Instagram]<https://…>`, `Share on X<https://…>`, `Victoria<mailto:…>`.
 * The operator asked (2026-09-10) for the link to be clickable and the URL
 * itself not to show. This splits a body into text and links so the view can
 * render the label as the link; a URL with no label shows as its host.
 */
export type Segment = { kind: "text"; text: string } | { kind: "link"; text: string; href: string };

const URL_RE = String.raw`(?:https?:\/\/[^\s<>()\[\]"']+|mailto:[^\s<>()\[\]"']+)`;
// In order: [Label]<url>, Label<url> (one word), <url>, url.
const TOKEN = new RegExp(
  String.raw`\[([^\[\]\n]{1,80})\]\s*<(${URL_RE})>` +
    String.raw`|([^\s<>()\[\]]{1,60})<(${URL_RE})>` +
    String.raw`|<(${URL_RE})>` +
    String.raw`|(${URL_RE})`,
  "g",
);

/** What a bare URL shows as: its host, without a leading www., or the address for mailto. */
export function linkLabel(href: string): string {
  if (href.startsWith("mailto:")) return href.slice("mailto:".length);
  try {
    const host = new URL(href).hostname.replace(/^www\./, "");
    return host.length > 40 ? `${host.slice(0, 39)}…` : host;
  } catch {
    return "link";
  }
}

/** Only http(s) and mailto survive; anything else is left as the text it was. */
function safeHref(href: string): string | null {
  return /^(https?:\/\/|mailto:)/i.test(href) ? href.replace(/[.,;:!?)]+$/, "") : null;
}

export function linkSegments(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    const [whole, bracketLabel, bracketUrl, wordLabel, wordUrl, angleUrl, bareUrl] = m;
    const raw = bracketUrl ?? wordUrl ?? angleUrl ?? bareUrl ?? "";
    const href = safeHref(raw);
    if (!href) continue;
    if (start > last) out.push({ kind: "text", text: text.slice(last, start) });
    out.push({ kind: "link", href, text: bracketLabel ?? wordLabel ?? linkLabel(href) });
    // A bare URL's trailing full stop belongs to the sentence, not the link.
    last = start + whole.length - (bareUrl ? raw.length - href.length : 0);
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}
