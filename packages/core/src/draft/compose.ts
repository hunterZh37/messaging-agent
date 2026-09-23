import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { accounts, messages } from "../db/schema";
import type { ModelProvider } from "../models/types";
import { HUMAN_STYLE_RULE, humanizePunctuation } from "./style";

/**
 * The words of a mail that begins a conversation (operator, 2026-09-22:
 * "Celeste should also be draft email").
 *
 * The drafter proper reads a thread and answers it; there is no thread here,
 * so this asks for the body from the instruction alone, in the operator's
 * voice. It writes nothing to the database and sends nothing: the text comes
 * back to the composer, where the operator edits it, and the draft it becomes
 * still goes out through the one gate.
 */

const MAX_TOKENS = 1200;

const RULES = `You write a single email for the operator, to someone they are writing to for the first time in this conversation.

- You are writing AS the operator, in their first person. Never sign as Celeste, never refer to yourself, and never write as an assistant writing on their behalf. Sign off the way the operator signs off in their voice, with their own name.
- Write only the body. No subject line, no "Subject:", no signature block beyond how the operator normally signs off.
- Say everything the operator asked for, and nothing they did not. Do not invent facts, dates, numbers, prices, or commitments.
- Where something is unknown, leave it plainly unsaid rather than guessing. The operator will fill it in.
- Keep it as short as the point allows. No preamble about writing an email.
- Plain text. No markdown headings or bullet characters unless the operator asked for a list.
${HUMAN_STYLE_RULE}`;

/**
 * What the operator calls themselves on this account, read from their own
 * last sent message. A reply picks the name up from the thread it answers;
 * a composed mail has no thread, and without this it signs off with a
 * placeholder where a name should be (2026-09-22).
 */
export function operatorNameFor(db: Db, accountId: string): string | null {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (!account) return null;
  const own = db
    .select({ name: messages.fromName })
    .from(messages)
    .where(and(eq(messages.accountId, accountId), eq(messages.fromAddress, account.email), isNotNull(messages.fromName)))
    .orderBy(desc(messages.sentAt))
    .limit(1)
    .get();
  const name = own?.name?.trim();
  return name ? name : null;
}

export interface ComposeTextInput {
  /** What the operator said the mail should say. Theirs, and trusted. */
  instruction: string;
  subject: string;
  to: string[];
  cc?: string[];
  /** How the operator signs off, when their own mail says. */
  fromName?: string | null;
}

export async function composeText(provider: ModelProvider, voice: string, input: ComposeTextInput): Promise<string> {
  const instruction = input.instruction.trim();
  if (!instruction) throw new Error("Say what the mail should say.");
  const lines = [
    ...(input.fromName ? [`You are ${input.fromName}. Sign off with that name, the way the voice above describes.`] : []),
    `To: ${input.to.join(", ")}`,
    ...(input.cc && input.cc.length > 0 ? [`Cc: ${input.cc.join(", ")}`] : []),
    `Subject: ${input.subject}`,
    "",
    "What the operator asked this mail to say:",
    instruction,
  ];
  const result = await provider.text({
    system: [
      { text: RULES, cache: true },
      { text: `# Operator voice\n\n${voice}`, cache: true },
    ],
    messages: [{ role: "user", content: lines.join("\n") }],
    maxTokens: MAX_TOKENS,
  });
  // Tidied the same way a reply is: the rule is in the prompt and applied
  // again after, because a model told not to reach for a dash still does.
  return humanizePunctuation(result.text.trim());
}
