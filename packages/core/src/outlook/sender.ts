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
