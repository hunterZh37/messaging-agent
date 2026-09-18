import type { NormalizedMessage } from "../connectors/types";
import { chatNameFrom } from "../connectors/names";
import type { WaMessage } from "./types";

export const WHATSAPP_FOLDER = "messages" as const;

/** Who the operator is on WhatsApp, for reading "me" out of a chat. */
export interface WaSelf {
  jid: string;
  lid: string | null;
  phone: string;
}

const MENTION = /@(\d{5,20})\b/g;

/**
 * WhatsApp writes a mention as "@<id>" in the text. Shown here as "@<name>",
 * and as "@you" when it is the operator (spec 10g: a group needs a reply when
 * its newest message mentions the operator).
 */
export function renderMentions(text: string, self: WaSelf, names: Map<string, string>): { text: string; mentionsOperator: boolean } {
  let mentionsOperator = false;
  const own = new Set([self.phone, self.lid?.replace(/@.*$/, "") ?? ""].filter(Boolean));
  const out = text.replace(MENTION, (whole, id: string) => {
    if (own.has(id)) {
      mentionsOperator = true;
      return "@you";
    }
    const name = names.get(`${id}@lid`) ?? names.get(`${id}@s.whatsapp.net`);
    return name ? `@${name}` : whole;
  });
  return { text: out, mentionsOperator };
}

export function normalizeWhatsapp(m: WaMessage, self: WaSelf, names: Map<string, string>, contacts: Map<string, string> = new Map(), readChats?: Set<string>): NormalizedMessage {
  const { text, mentionsOperator } = renderMentions(m.text ?? "", self, names);
  const group = m.chat.kind === "group";
  const other = group ? m.chat.jid : (m.senderJid ?? m.chat.jid);
  return {
    providerMessageId: m.stanzaId,
    providerThreadId: m.chat.jid,
    rfcMessageId: m.stanzaId,
    fromAddress: m.isFromMe ? self.jid : (m.senderJid ?? other),
    fromName: m.isFromMe ? null : m.senderName,
    toAddresses: [m.isFromMe ? m.chat.jid : self.jid],
    ccAddresses: [],
    // A chat WhatsApp names by a number takes its name from Contacts on this Mac when it has one (2026-09-14).
    subject: m.chat.kind === "group" ? m.chat.name : chatNameFrom(m.chat.name, m.chat.phone, contacts),
    bodyText: text,
    bodyHtml: null,
    snippet: text.slice(0, 200) || (m.media ? "An attachment" : null),
    attachmentNames: m.media ? [m.media.filename] : [],
    attachments: m.media ? [{ index: 0, filename: m.media.filename, mimeType: mimeOf(m.media.filename), size: m.media.size, providerAttachmentId: m.media.path, bytes: null }] : [],
    folder: WHATSAPP_FOLDER,
    sentAt: m.sentAt,
    labelIds: [],
    isFromOperator: m.isFromMe,
    mentionsOperator,
    // A chat WhatsApp counts no unread in has been read, on the phone or here (2026-09-14).
    ...(readChats ? { read: readChats.has(m.chat.jid) } : {}),
  };
}

const MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  pdf: "application/pdf",
};
export function mimeOf(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}
