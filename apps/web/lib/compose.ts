import { invalidAddresses } from "./format";

/**
 * Compose (spec 2026-09-22): a message that begins a conversation rather than
 * answering one. This is the web-only half of it, pure and tested the way
 * the reply queue's own logic is (see lib/queue.ts, lib/format.ts) — the
 * writing itself is `composeDraft` in core.
 */

/** "a@x.com, b@y.com" split the same way a reply's To and Cc fields are (DraftCard's own `parseList`). */
export function parseAddressList(s: string): string[] {
  return s
    .split(/[,\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Why "Add to Drafts" is held back, worded for the composer. Mirrors
 * `sendBlockFor` in lib/format.ts — nowhere to send it, or an address that
 * cannot be one — plus the two things a reply gets for free and a composed
 * message does not: an account to send from, and a subject, since there is
 * no thread to take one from (spec 2026-09-22).
 */
export function composeBlockFor(opts: { accountId: string; to: string[]; cc: string[]; subject: string }): string | undefined {
  if (!opts.accountId) return "Pick an account to send from.";
  if (opts.to.length === 0) return "Needs someone in To.";
  const bad = invalidAddresses([...opts.to, ...opts.cc]);
  if (bad.length > 0) return `Not an address: ${bad.join(", ")}`;
  if (!opts.subject.trim()) return "Needs a subject.";
  return undefined;
}

/** Why "Draft with Celeste" is held back: it only needs the one line saying what the email should tell them. */
export function celesteBlockFor(instruction: string): string | undefined {
  return instruction.trim() ? undefined : "Say what the email should tell them.";
}

/**
 * The dash-and-semicolon cleanup every reply gets (`humanizePunctuation` in
 * packages/core/src/draft/style.ts), repeated here because compose's
 * one-line-instruction call goes straight to the model provider rather than
 * through `Drafter.draft` (see `draftWithCelesteAction` in app/actions.ts):
 * the operator's no-dash, no-semicolon rule applies to this text too, and it
 * is not worth a new core export for the one call site that needs it.
 */
export function humanizeComposePunctuation(text: string): string {
  return text
    .replace(/[ \t]*[—–][ \t]*(?=\n|$)/g, "")
    .replace(/[ \t]*[—–][ \t]*/g, ", ")
    .replace(/(\S)\s+-\s+(\S)/g, "$1, $2")
    .replace(/,\s*([,.!?:])/g, "$1")
    .replace(/,\s*(\n|$)/g, "$1")
    .replace(/;\s*(\S)/g, (_m, c: string) => `. ${c.toUpperCase()}`)
    .replace(/;/g, ".");
}

/**
 * "First message ever sent to this address: a@x.com, b@y.com" (spec
 * 2026-09-22: a plain warning, every recipient named in full, never a
 * block). Null when nobody on the draft is new, so the dialog can leave the
 * line out entirely.
 */
export function firstContactLabel(addresses: string[]): string | null {
  if (addresses.length === 0) return null;
  const [determiner, noun] = addresses.length === 1 ? ["this", "address"] : ["these", "addresses"];
  return `First message ever sent to ${determiner} ${noun}: ${addresses.join(", ")}`;
}
