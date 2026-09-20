/**
 * Bold and underline in a plain textarea (operator, 2026-09-20: "there should
 * be buttons for bolding and underlying texts").
 *
 * The draft stays one string, marks and all, which is what keeps revise, the
 * undo stack and the change diff working: each of them reads a draft as a
 * string and none of them has to learn about formatting. So the buttons do
 * what a person would do by hand, only exactly: wrap the selection, or take
 * the wrapping off when it is already there.
 */
export type Mark = "bold" | "underline";

const MARKER: Record<Mark, string> = { bold: "**", underline: "__" };

export interface Marked {
  text: string;
  /** Where the selection should sit afterwards, so typing carries on where it was. */
  start: number;
  end: number;
}

/**
 * Toggle a mark over [start, end).
 *
 * Toggling rather than wrapping: pressing B twice is how a person asks for
 * the bold back off, and wrapping twice would leave `****word****`, which
 * renders as nothing anybody wanted.
 */
export function toggleMark(text: string, start: number, end: number, mark: Mark): Marked {
  const m = MARKER[mark];
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  // Nothing selected is not an error, it is a press with nothing to act on.
  if (from === to) return { text, start: from, end: to };

  const selected = text.slice(from, to);
  // Already wrapped, either inside the selection or just outside it.
  if (selected.length > 2 * m.length && selected.startsWith(m) && selected.endsWith(m)) {
    const bare = selected.slice(m.length, selected.length - m.length);
    return { text: text.slice(0, from) + bare + text.slice(to), start: from, end: from + bare.length };
  }
  if (text.slice(from - m.length, from) === m && text.slice(to, to + m.length) === m) {
    const cut = text.slice(0, from - m.length) + selected + text.slice(to + m.length);
    return { text: cut, start: from - m.length, end: to - m.length };
  }

  // Trailing space inside the mark renders as a mark around nothing at the
  // end, so the wrap tightens onto the words and leaves the space outside.
  const lead = selected.length - selected.trimStart().length;
  const tail = selected.length - selected.trimEnd().length;
  const core = selected.slice(lead, selected.length - tail);
  if (core.length === 0) return { text, start: from, end: to };
  const wrapped = `${selected.slice(0, lead)}${m}${core}${m}${selected.slice(selected.length - tail)}`;
  return { text: text.slice(0, from) + wrapped + text.slice(to), start: from, end: from + wrapped.length };
}

/** Whether the selection is already carrying this mark, so the button can say so. */
export function marked(text: string, start: number, end: number, mark: Mark): boolean {
  const m = MARKER[mark];
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  if (from === to) return false;
  const selected = text.slice(from, to);
  if (selected.length > 2 * m.length && selected.startsWith(m) && selected.endsWith(m)) return true;
  return text.slice(from - m.length, from) === m && text.slice(to, to + m.length) === m;
}
