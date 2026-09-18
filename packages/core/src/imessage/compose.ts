import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Sender } from "../connectors/types";
import { now, type Db } from "../db/client";
import { accounts, drafts, messages, threads } from "../db/schema";
import { sendDraft } from "../queue/drafts";

/** The `model` a draft carries when the operator typed it themselves. */
export const OPERATOR_MODEL = "operator";

/**
 * A text the operator typed into a chat (operator, 2026-09-11: "a place
 * where I can type out a message"). It goes through the same door as a
 * reply Celeste wrote: a draft row, so the Sent history and the send path
 * are one, and then the text sender at once. The handle is whoever the
 * chat is with: the last text's sender, or its recipient when the operator
 * wrote last.
 */
export async function sendText(
  db: Db,
  sender: Sender,
  p: { threadId: string; text: string },
  clock: () => number = now,
): Promise<{ draftId: string; providerMessageId: string }> {
  const text = p.text.trim();
  if (text === "") throw new Error("The text is empty.");
  const thread = db.select().from(threads).where(eq(threads.id, p.threadId)).get();
  if (!thread) throw new Error(`thread not found: ${p.threadId}`);
  const account = db.select().from(accounts).where(eq(accounts.id, thread.accountId)).get();
  if (!account || (account.provider !== "imessage" && account.provider !== "whatsapp")) throw new Error("Only a chat can be texted.");
  const latest = db.select().from(messages).where(eq(messages.threadId, thread.id)).orderBy(desc(messages.sentAt), desc(messages.id)).get();
  if (!latest) throw new Error(`thread has no messages: ${p.threadId}`);
  // A WhatsApp chat is addressed by the chat itself (a group has no one handle); a Messages chat by the other person's handle.
  const handle = account.provider === "whatsapp" ? thread.providerThreadId : latest.isFromOperator ? latest.toAddresses[0] : latest.fromAddress;
  if (!handle) throw new Error("No one to text.");

  const t = clock();
  const draftId = randomUUID();
  db.insert(drafts)
    .values({
      id: draftId,
      threadId: thread.id,
      replyToMessageId: latest.id,
      originalText: text,
      finalText: null,
      toAddresses: [handle],
      ccAddresses: [],
      status: "pending",
      mode: "reply",
      model: OPERATOR_MODEL,
      sentProviderMessageId: null,
      error: null,
      createdAt: t,
      updatedAt: t,
    })
    .run();
  const sent = await sendDraft(db, sender, { draftId, finalText: text, to: [handle], cc: [] }, clock);
  return { draftId, providerMessageId: sent.providerMessageId };
}
