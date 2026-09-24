import { validateRecipients } from "../connectors/mime";
import type { MailSender } from "../connectors/types";
import type { SmtpClient } from "./types";

/**
 * Wraps an SmtpClient as the provider-agnostic Sender. The reply stays in the
 * thread through In-Reply-To and References; nodemailer builds the MIME, the
 * draft's files included.
 */
export function imapSender(smtp: SmtpClient): MailSender {
  return {
    /**
     * A message that starts a conversation (compose, 2026-09-22): the same
     * send without In-Reply-To or References, so no mail client files it
     * under something the recipient never wrote.
     */
    async sendNew(p) {
      validateRecipients(p.to, p.cc);
      const attachments = (p.attachments ?? []).map((a) => ({ filename: a.filename, content: a.bytes, contentType: a.mimeType }));
      const sent = await smtp.send({
        from: p.from,
        to: p.to,
        cc: p.cc,
        subject: p.subject,
        text: p.body,
        ...(p.html ? { html: p.html } : {}),
        inReplyTo: null,
        references: null,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      return { id: sent.messageId };
    },

    async sendReply(p) {
      validateRecipients(p.to, p.cc);
      const attachments = (p.attachments ?? []).map((a) => ({ filename: a.filename, content: a.bytes, contentType: a.mimeType }));
      const sent = await smtp.send({
        from: p.from,
        to: p.to,
        cc: p.cc,
        subject: p.subject,
        text: p.body,
        ...(p.html ? { html: p.html } : {}),
        inReplyTo: p.inReplyTo,
        references: p.inReplyTo,
        // Left off entirely when there are none: nodemailer reads an empty
        // array the same way, but a reply with no files should look like one.
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      return { id: sent.messageId };
    },
  };
}
