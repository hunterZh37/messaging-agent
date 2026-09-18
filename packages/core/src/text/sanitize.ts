import sanitizeHtmlLib from "sanitize-html";

const ALLOWED_TAGS = [
  "p",
  "br",
  "div",
  "span",
  "a",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "ul",
  "ol",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "code",
  "table",
  "thead",
  "tbody",
  "tr",
  "td",
  "th",
  "img",
  "hr",
  // Legacy email markup: senders (Bill.com among them) still build layout
  // with these instead of CSS.
  "center",
  "font",
];

const ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  // rel/target are not sender-controlled: transformTags below forces them on
  // every link, but they still have to be allowlisted or the attribute
  // filter strips them right back off after the transform runs.
  a: ["href", "title", "rel", "target"],
  img: ["src", "alt", "width", "height", "align"],
  table: ["width", "cellpadding", "cellspacing", "border", "align", "bgcolor"],
  tr: ["align", "valign", "bgcolor"],
  td: ["colspan", "rowspan", "width", "height", "align", "valign", "bgcolor"],
  th: ["colspan", "rowspan", "width", "height", "align", "valign", "bgcolor"],
  div: ["align"],
  p: ["align"],
  h1: ["align"],
  h2: ["align"],
  h3: ["align"],
  h4: ["align"],
  h5: ["align"],
  h6: ["align"],
  font: ["color", "size"],
  // `style` is allowed on every element (see allowedStyles below); only a
  // narrow, non-executable property allowlist survives per element.
  "*": ["style"],
};

/** Matches `#abc`, `#aabbcc`, `#aabbccdd`, `rgb(...)`/`rgba(...)`, or a bare CSS color keyword. */
const COLOR = [/^#[0-9a-f]{3,8}$/i, /^rgba?\(/i, /^[a-z]+$/i];
const LENGTH = /^[\d.]+(px|em|%)$/;
const LENGTH_OR_AUTO = /^(auto|[\d.]+(px|em|%))$/;
const BORDER = /^[\d.]+px (solid|dashed|dotted|none) (#[0-9a-f]{3,8}|[a-z]+)$/i;

/**
 * The style declarations kept on any element. Deliberately excludes
 * `font-family` (the app's own type stays), `position`, and anything that
 * could carry a url() (e.g. `background-image`) — `background`/`background-color`
 * only accept a flat color, never a url().
 */
const ALLOWED_STYLES = {
  "*": {
    color: COLOR,
    "background-color": COLOR,
    background: COLOR,
    "text-align": [/^(left|right|center|justify)$/],
    "font-weight": [/^(normal|bold|[1-9]00)$/],
    "font-size": [/^\d+(\.\d+)?(px|pt|em|rem|%)$/],
    "font-style": [/^(normal|italic)$/],
    "text-decoration": [/^(none|underline|line-through)$/],
    "line-height": [/^\d+(\.\d+)?(px|em|%)?$/],
    padding: [/^[\d.]+(px|em|%)( [\d.]+(px|em|%)){0,3}$/],
    "padding-top": [LENGTH],
    "padding-right": [LENGTH],
    "padding-bottom": [LENGTH],
    "padding-left": [LENGTH],
    margin: [/^(auto|[\d.]+(px|em|%))( (auto|[\d.]+(px|em|%))){0,3}$/],
    "margin-top": [LENGTH_OR_AUTO],
    "margin-right": [LENGTH_OR_AUTO],
    "margin-bottom": [LENGTH_OR_AUTO],
    "margin-left": [LENGTH_OR_AUTO],
    "border-radius": [/^[\d.]+(px|%)$/],
    border: [BORDER],
    "border-top": [BORDER],
    "border-right": [BORDER],
    "border-bottom": [BORDER],
    "border-left": [BORDER],
    width: [/^\d+(px|%)$/],
    "max-width": [/^\d+(px|%)$/],
    height: [/^\d+(px|%)$/],
    display: [/^(block|inline|inline-block|none|table|table-cell|table-row)$/],
    "vertical-align": [/^(top|middle|bottom|baseline)$/],
    "white-space": [/^(normal|nowrap|pre-wrap)$/],
    "text-transform": [/^(none|uppercase|lowercase|capitalize)$/],
    "letter-spacing": [/^-?[\d.]+(px|em)$/],
  },
};

/**
 * A sender's "preheader" (a div meant to show only in the inbox preview, seen
 * live on LinkedIn and Substack mail) is styled to be invisible in a mail
 * client but keeps its text: once the style vocabulary above strips the
 * hiding declaration, the text is left with nothing hiding it and renders as
 * a one-character-wide column beside the body (operator, 2026-09-11). This
 * reads `frame.attribs.style` before sanitize-html's own style filter has
 * rewritten it (that filter only overwrites the output string, not the
 * frame), so the original declaration is still here to check against.
 * Declarations are parsed loosely: split on `;` then the first `:`, trimmed
 * and lowercased, which is enough for how these are actually written.
 */
function hidesContent(style: string | undefined): boolean {
  if (!style) return false;
  const declared = new Map<string, string>();
  for (const part of style.split(";")) {
    const sep = part.indexOf(":");
    if (sep < 0) continue;
    const prop = part.slice(0, sep).trim().toLowerCase();
    const value = part.slice(sep + 1).trim().toLowerCase();
    if (prop) declared.set(prop, value);
  }
  const isZero = (v: string | undefined) => v === "0" || v === "0px";
  return (
    declared.get("display") === "none" ||
    declared.get("visibility") === "hidden" ||
    declared.get("opacity") === "0" ||
    // font-size:0 alone is not hiding: MJML wraps every column in a
    // font-size:0px div to swallow inline-block gaps and the content inside
    // sets its own size (seen live, 2026-09-11: an Amazon shipping mail
    // rendered as an empty box). A preheader pairs it with a zero
    // line-height or max-height, or clips it.
    (isZero(declared.get("font-size")) &&
      (isZero(declared.get("line-height")) || isZero(declared.get("max-height")) || declared.get("overflow") === "hidden")) ||
    isZero(declared.get("max-height")) ||
    // A box of no width or no height is hiding what it holds whatever else
    // it says (seen live, 2026-09-11: a LinkedIn preheader kept width:0px
    // once overflow was stripped, and rendered as a column of letters;
    // a height:0px wrapper let the mail spill over the buttons under it).
    isZero(declared.get("width")) ||
    isZero(declared.get("height")) ||
    declared.get("mso-hide") === "all"
  );
}

/**
 * Sanitizes a mail HTML body for direct rendering in the thread view. Applied
 * once at store time; the web app must not re-sanitize on the client. Strips
 * everything that could execute or phone home (script, on*, iframe, form,
 * inputs, javascript: urls, classes/ids) and keeps only the formatting tags
 * and a narrow, non-executable style vocabulary an email actually needs —
 * enough to keep a sender's button/heading/footer layout without keeping
 * `font-family`, `position`, or any `url()`-bearing declaration. `cid:`
 * images are dropped rather than resolved — no inline image support in v1.
 */
export function sanitizeHtml(html: string): string {
  // `exclusiveFilter` runs on `frame.attribs`, but that object has by then
  // already had its `style` deleted by sanitize-html's own style filter
  // whenever nothing in it survives the allowlist (which is every hiding
  // declaration below, none of them are in ALLOWED_STYLES, on purpose). So
  // the raw style is read here instead, from `onOpenTag`, which fires before
  // any filtering. It is kept by nesting depth rather than a plain stack:
  // `onOpenTag`/`onCloseTag` fire for every tag including ones exclusiveFilter
  // never sees (an email's own `<html>`/`<head>`/`<body>` are not on
  // `allowedTags`), so a plain push/pop pair would drift out of sync with
  // exclusiveFilter's calls. Depth does not drift, because both callbacks
  // fire unconditionally and in matching pairs.
  let depth = 0;
  const styleAtDepth: (string | undefined)[] = [];
  return sanitizeHtmlLib(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedStyles: ALLOWED_STYLES,
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["https"] },
    // Text inside these never belongs in the body. sanitize-html's default
    // list lacks `title`, so an email's <title> leaked in as a stray word.
    nonTextTags: ["script", "style", "textarea", "option", "title", "head"],
    onOpenTag: (_name, attribs) => {
      styleAtDepth[depth] = attribs.style;
      depth++;
    },
    onCloseTag: () => {
      depth--;
    },
    // Dropped whole, content included, rather than losing only the style
    // that was hiding it: a preheader's text has nowhere honest to go once
    // it is not hidden any more (2026-09-11).
    exclusiveFilter: () => hidesContent(styleAtDepth[depth]),
    transformTags: {
      a: sanitizeHtmlLib.simpleTransform("a", { rel: "noopener noreferrer", target: "_blank" }, true),
      table: fluidWidth,
      td: fluidWidth,
      th: fluidWidth,
    },
  });
}

const PX_WIDTH_ATTR = /^(\d+)(px)?$/;
const PX_WIDTH_STYLE = /(^|;)\s*width\s*:\s*(\d+)px\s*(?=;|$)/i;

/**
 * Senders lay email out in fixed-pixel tables (640px is the convention) that
 * are wider than the thread pane. A fixed `width` becomes `max-width` plus
 * `width:100%` so the layout fills the pane up to the sender's intended width
 * and shrinks below it instead of overflowing sideways. Percent widths and
 * unsized tables (buttons, spacers) are left alone.
 */
function fluidWidth(tagName: string, attribs: sanitizeHtmlLib.Attributes): sanitizeHtmlLib.Tag {
  const out: sanitizeHtmlLib.Attributes = { ...attribs };
  const attr = out.width?.trim().match(PX_WIDTH_ATTR);
  if (attr) delete out.width;
  // A table fills the pane up to its intended width. A cell only gets the
  // cap: giving every cell in a row width:100% made the browser hand the
  // whole row to one of them and squeeze its neighbour to a letter per line
  // (a signature next to a photo column).
  const fill = tagName === "table" ? ";width:100%" : "";
  if (out.style && PX_WIDTH_STYLE.test(out.style)) {
    // The inline style wins over the attribute in browsers, so it alone
    // decides the max-width.
    out.style = out.style.replace(PX_WIDTH_STYLE, `$1max-width:$2px${fill}`);
  } else if (attr) {
    const fluid = `max-width:${attr[1]}px${fill}`;
    out.style = out.style ? `${out.style.replace(/;\s*$/, "")};${fluid}` : fluid;
  }
  return { tagName, attribs: out };
}
