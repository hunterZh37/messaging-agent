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
  // The same thing said without the word "draft" (review, 2026-09-24).
  /\b(?:the|your) card (?:is|has been) (?:now )?(?:updated|revised|changed)\b/i,
  /\b(?:that|it)(?:'s| is) (?:now )?in (?:the|your) draft\b/i,
  /\bi(?:'ve| have) (?:gone ahead and )?(?:updated|revised|rewritten|edited) it\b/i,
  /\bit(?:'s| is) (?:now )?(?:updated|revised|rewritten) on your (?:screen|card)\b/i,
];

/**
 * An offer or a plan, not a claim — but only when the modal governs a verb
 * about changing the draft. "I can confirm the draft is updated" asserts it
 * (review, 2026-09-24); "I can update the draft" does not.
 */
const NOT_YET = /\b(?:i can|i could|i'll|i will|i would|shall i|should i|want me to|would you like|do you want|if you want)\s+(?:\w+\s+){0,2}(?:update|updating|revise|revising|rewrite|rewriting|change|changing|edit|editing|apply|applying|fold|adding|add)\b/i;

/**
 * A denial reads like a claim with one word in it: "I have not changed the
 * draft" says the opposite of what the pattern matches (found by its own
 * test, 2026-09-24).
 */
const DENIED = /\b(?:not|never|n't|without|nothing|neither)\b[^.;!?]{0,40}$/i;

/**
 * Words the answer is only repeating: what the operator said, what a message
 * said, what she said last time. A claim inside quotation marks is not a
 * claim about the card in front of them (review, 2026-09-24).
 */
function withoutQuotations(answer: string): string {
  return answer
    .replace(/"[^"]*"/g, " ")
    .replace(/\u201c[^\u201d]*\u201d/g, " ")
    .replace(/^>.*$/gm, " ");
}

/** Does this answer tell the operator their draft has already changed? */
export function claimsDraftChanged(answer: string): boolean {
  const text = withoutQuotations(answer);
  // Sentence by sentence: an offer in one sentence says nothing about a
  // claim in the next (review, 2026-09-24).
  for (const sentence of text.split(/(?<=[.!?\n])\s+/)) {
    for (const pattern of CLAIMS) {
      const match = pattern.exec(sentence);
      if (!match) continue;
      if (NOT_YET.test(sentence)) continue;
      if (DENIED.test(sentence.slice(0, match.index))) continue;
      return true;
    }
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
