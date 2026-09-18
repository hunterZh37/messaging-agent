import type { MessageRow } from "../db/schema";

/**
 * Whether the drafter is answering someone or nudging them: a thread whose
 * last message is the operator's has nothing inbound to answer, so a draft
 * on it is a follow-up (spec 6).
 */
export type DraftMode = "reply" | "follow-up";

export interface DraftContext {
  operatorEmail: string;
  mode: DraftMode;
  /** Mail, or a text conversation (2026-09-11): a text is short, has no greeting and no sign-off. */
  channel?: "mail" | "text";
  replyTo: MessageRow;
  /** Up to 10 most recent messages in the thread, oldest first. Includes replyTo. */
  thread: MessageRow[];
  /** Up to 5 most recent operator messages addressed to replyTo.fromAddress. */
  sentToSender: MessageRow[];
  /** Up to 10 most recent operator messages to anyone. */
  sentGlobal: MessageRow[];
}

/**
 * Tool-less. Returns reply body text only, or the one-line
 * `NO REPLY: <reason>` when the mail asks nothing of the operator (an
 * automated notice, a receipt, a newsletter); `declined()` in run.ts reads
 * that line. `force` says the operator asked for a draft regardless, so the
 * line is never the answer.
 */
export interface Drafter {
  readonly model: string;
  /**
   * `instruction` is what the operator asked the draft to say, when they
   * said anything (Ask Celeste, 2026-09-14). Theirs and trusted, like a
   * revision's; every point in it goes into the draft.
   */
  draft(voice: string, ctx: DraftContext, opts?: { force?: boolean; instruction?: string }): Promise<string>;
  /**
   * "Revise with Celeste" (spec 8, 2026-09-10): the operator says what to
   * change and gets the whole body back. `instruction` is theirs and is
   * trusted; the thread inside `ctx` stays untrusted data.
   */
  revise(voice: string, ctx: DraftContext, current: string, instruction: string): Promise<string>;
}
