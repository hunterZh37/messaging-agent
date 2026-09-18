import type { Sender } from "../connectors/types";
import type { AppleScriptRunner } from "../imessage/types";
import { sendInWhatsapp } from "./app";
import { WHATSAPP_GROUP_REPLY_OFF, type WhatsappSource } from "./types";

/**
 * The sender behind a WhatsApp reply (spec 10g). The chat is the draft's
 * thread; WhatsApp.app is driven to send, and the send is confirmed by
 * reading the text back from ChatStorage: nothing found in a few seconds
 * means it did not go, and the draft stays.
 */
export function whatsappSender(source: WhatsappSource, run: AppleScriptRunner, clock: () => number = Date.now): Sender {
  return {
    async sendReply(p) {
      const chat = source.chat(p.providerThreadId);
      if (!chat) throw new Error(`WhatsApp has no chat ${p.providerThreadId}.`);
      // The UI does not offer this, and neither does anything else: a group
      // send cannot be confirmed before it goes (2026-09-16).
      if (chat.kind === "group") throw new Error(WHATSAPP_GROUP_REPLY_OFF);
      const startedAt = clock();
      await sendInWhatsapp(run, chat, p.body);
      for (let i = 0; i < 20; i++) {
        const sent = source.latestOwnMessage(chat.jid, startedAt - 60_000, p.body);
        if (sent) return { id: sent.stanzaId };
        await new Promise((r) => setTimeout(r, 400));
      }
      throw new Error(`WhatsApp shows no message sent to ${chat.name}.`);
    },
  };
}
