import type { Sender } from "../connectors/types";
import type { OutlookClient } from "./types";

/**
 * Wraps an OutlookClient as the provider-agnostic Sender: createReply ->
 * updateDraft -> attach -> send, in that order. The files go on before the
 * send, because Graph will not attach anything to a message once it is gone,
 * and one that fails to attach throws rather than sending the mail without it.
 */
export function outlookSender(client: OutlookClient): Sender {
  return {
    /** A message with nothing above it: a fresh Graph draft, then the same road out. */
    async sendNew(p) {
      const { draftId } = await client.createMessage({ subject: p.subject, to: p.to, cc: p.cc });
      await client.updateDraft(draftId, { body: p.body, ...(p.html ? { html: p.html } : {}), to: p.to, cc: p.cc });
      for (const file of p.attachments ?? []) await client.addAttachment(draftId, file);
      await client.sendDraft(draftId);
      return { id: draftId };
    },

    async sendReply(p) {
      const { draftId } = await client.createReply(p.replyToProviderMessageId);
      await client.updateDraft(draftId, { body: p.body, ...(p.html ? { html: p.html } : {}), to: p.to, cc: p.cc });
      // One at a time and in the operator's order, so the chips on the card
      // and the files on the mail read the same way round.
      for (const file of p.attachments ?? []) await client.addAttachment(draftId, file);
      await client.sendDraft(draftId);
      return { id: draftId };
    },
  };
}
