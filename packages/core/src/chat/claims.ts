import type { ProposedAction } from "./types";

/**
 * "The draft is updated on your screen", when it is not.
 *
 * Celeste is told that an applied draft lands on the card the moment she
 * proposes it, so she may speak of the change as done. She learned the
 * sentence and then said it without proposing anything: the operator read
 * "Draft updated on your screen" twice over a card that had not moved
 * (2026-09-24, reproduced). A claim about what is on their screen has to be
 * true the way a quote has to match the message it cites, so it is checked
 * the same way and sent back once.
 */

/**
 * Something said about the draft as though it had already changed. Written
 * narrowly: an offer ("I can update the draft"), a question ("shall I update
 * the draft?") and a plan ("I'll update the draft") are not claims.
 */
const CLAIMS = [
  /\bdraft (?:is|has been|was) (?:now )?(?:updated|revised|rewritten|changed|edited)\b/i,
  /\b(?:updated|revised|rewritten|changed|edited) (?:the|your) draft\b/i,
  /\bdraft (?:updated|revised|rewritten) on your screen\b/i,
  /\bthe draft (?:now )?(?:says|reads)\b/i,
  /\bapplied (?:it |that |the text )?to (?:the|your) draft\b/i,
  /\bit (?:is|'s) on your card\b/i,
];

/** Words that turn a claim back into an offer or a plan, read just before it. */
const NOT_YET = /\b(?:i can|i could|i'll|i will|shall i|should i|want me to|would you like|if you want|do you want)\b[^.!?]{0,80}$/i;

/** Does this answer tell the operator their draft has already changed? */
export function claimsDraftChanged(answer: string): boolean {
  for (const pattern of CLAIMS) {
    const match = pattern.exec(answer);
    if (!match) continue;
    const before = answer.slice(0, match.index);
    if (NOT_YET.test(before)) continue;
    return true;
  }
  return false;
}

/**
 * The claim is only true when something will actually land on the card: an
 * `apply_draft` carrying the whole body, or a draft proposal the panel runs
 * itself over the open draft's own thread.
 */
export function changesTheDraft(actions: ProposedAction[], openDraftThreadId: string | null): boolean {
  return actions.some((a) => {
    if (a.kind === "apply_draft") return (a.text ?? "").trim() !== "";
    if (a.kind !== "draft_reply" && a.kind !== "draft_follow_up") return false;
    if (!openDraftThreadId || (a.instruction ?? "").trim() === "") return false;
    const threads = a.threadIds.length > 0 ? a.threadIds : a.threadId ? [a.threadId] : [];
    return threads.length === 1 && threads[0] === openDraftThreadId;
  });
}

/** What she is told when she said it without doing it. Once. */
export const CLAIM_CORRECTION =
  'You wrote that the draft has been changed, but you proposed nothing that changes it, so the operator is looking at the same card they were before. Either call propose_action with kind "apply_draft" and the whole revised body in draft_text, or answer again without saying the draft has changed. Do not say a thing is done that you have not done.';

/** Said under an answer that claimed it twice: the operator is told plainly. */
export const CLAIM_WARNING = "The draft on your screen was not changed.";
