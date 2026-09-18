/**
 * The = key (its cap says + too) hides the open thread (operator, 2026-09-11):
 * bare, or with Shift for the +, never with a command key, and never while
 * a field has the keyboard.
 */
export function isHideKey(ev: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: EventTarget | null }): boolean {
  if (ev.key !== "=" && ev.key !== "+") return false;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return false;
  const t = ev.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return false;
  return true;
}

/**
 * Is this the key that deletes the thread on screen (operator, 2026-09-11:
 * "press Delete to delete an email")? Delete or Backspace, bare, and not
 * while typing anywhere, so a backspace in the Ask box or the draft never
 * reaches the mail.
 */
export function isDeleteKey(ev: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: EventTarget | null }): boolean {
  if (ev.key !== "Delete" && ev.key !== "Backspace") return false;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return false;
  const t = ev.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return false;
  return true;
}

/**
 * Is this the key that brings the last deleted mail back (operator,
 * 2026-09-11: "press Command-Z to bring back the previously deleted email")?
 * Cmd-Z on a Mac, Ctrl-Z elsewhere, without Shift (which is redo in every
 * editor), and never while typing: an undo in the Ask box or the draft is
 * the field's own.
 */
export function isUndoKey(ev: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; target: EventTarget | null }): boolean {
  if (ev.key !== "z" && ev.key !== "Z") return false;
  if (ev.metaKey === ev.ctrlKey) return false;
  if (ev.altKey || ev.shiftKey) return false;
  const t = ev.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return false;
  return true;
}

/**
 * Is the operator on a touch screen with no pointer that hovers? Decides
 * whether a delete says Undo on its toast (a phone has no Cmd-Z) and
 * whether the row × waits for a hover it will never get (the phone pass,
 * 2026-09-11).
 */
export function byTouch(): boolean {
  return typeof window !== "undefined" && (window.matchMedia?.("(hover: none)").matches ?? false);
}

/**
 * Down or up the list from the keyboard (stress audit, 2026-09-11: the
 * Drafts list answered j and k and the arrows, the mail lists did not).
 * 1 for j or ArrowDown, -1 for k or ArrowUp, 0 for anything else; bare keys
 * only, never while typing, and never one something else already took.
 */
export function listStep(ev: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; defaultPrevented: boolean; target: EventTarget | null }): -1 | 0 | 1 {
  if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey) return 0;
  const t = ev.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return 0;
  if (ev.key === "j" || ev.key === "ArrowDown") return 1;
  if (ev.key === "k" || ev.key === "ArrowUp") return -1;
  return 0;
}


/**
 * The next row to move to with j or k: the first row past the selected one
 * whose thread is different (stress loop, 2026-09-11: a chat's earlier texts
 * are rows of the same thread, and j walked them one by one going nowhere).
 * With nothing selected, the first or the last row.
 */
export function nextThreadRow<T extends { threadId: string; selected: boolean }>(rows: T[], step: -1 | 1): T | null {
  if (rows.length === 0) return null;
  const at = rows.findIndex((r) => r.selected);
  if (at < 0) return step > 0 ? rows[0]! : rows[rows.length - 1]!;
  const current = rows[at]!.threadId;
  for (let i = at + step; i >= 0 && i < rows.length; i += step) {
    if (rows[i]!.threadId !== current) return rows[i]!;
  }
  return null;
}
