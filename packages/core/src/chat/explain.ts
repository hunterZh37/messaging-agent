import type { ModelProvider } from "../models/types";

/** What a message needs to say about itself for one sentence to be written about it. */
export interface Explainable {
  subject: string;
  from: string;
  sentAt: number;
  bodyText: string;
}

/** Past this a message is a document; one sentence does not need all of it. */
const BODY_LIMIT = 4_000;

/** One sentence, so a model that writes an essay is cut off rather than overflowing the popover. */
const MAX_TOKENS = 120;

/**
 * What one message is about, in a sentence (spec 2026-10-07). This is the only
 * part of a result card that spends money, and it runs only when the operator
 * presses Explain — the text under the score comes free from the ranking and
 * is already on their screen.
 *
 * It answers the question they asked, not the message in general: "what is
 * this about" is a summary, and a summary is what they would get by opening
 * the mail themselves. What they pressed the button for is why this message
 * came back for that question.
 */
export async function explainMessage(provider: ModelProvider, message: Explainable, query: string): Promise<string> {
  const asked = query.trim();
  const { text } = await provider.text({
    system: [
      {
        text: [
          "You say, in one sentence, what a message is about and why it answers the question the operator asked.",
          "One sentence. No preamble, no 'This message', no quoting the subject back.",
          "Say what the person wants or is telling them, in plain words.",
          "If the message has nothing to do with the question, say that plainly instead of stretching to connect them.",
        ].join("\n"),
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          asked ? `They asked: ${asked}` : "They did not say what they were looking for.",
          "",
          `From: ${message.from}`,
          `Subject: ${message.subject}`,
          "",
          message.bodyText.slice(0, BODY_LIMIT),
        ].join("\n"),
      },
    ],
    maxTokens: MAX_TOKENS,
  });

  // A model that answered with nothing has not answered. Better to say the ask
  // failed and leave the free text standing than to open a blank popover.
  const said = text.replace(/\s+/g, " ").trim();
  if (!said) throw new Error("Celeste said nothing about that message.");
  return said;
}
