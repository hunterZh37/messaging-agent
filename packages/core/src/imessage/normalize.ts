import type { NormalizedMessage } from "../connectors/types";
import { normalizeHandle } from "./contacts";
import type { TextRow } from "./types";

/** The folder every text lives in: its own, beside the four mail folders (2026-09-11). */
export const TEXTS_FOLDER = "messages" as const;

/**
 * One text in the shape the rest of core stores. A chat is a thread whose
 * subject is the other person's name (or their number, when the address
 * book has no name), so every list and heading reads naturally. A text has
 * no HTML, no subject of its own, no Cc; its guid stands in for a
 * Message-ID.
 */
export function normalizeText(t: TextRow, ownHandle: string, names: Map<string, string>): NormalizedMessage {
  const other = t.handle;
  const name = names.get(normalizeHandle(other)) ?? null;
  const body = t.text ?? "";
  return {
    providerMessageId: t.guid,
    providerThreadId: t.chatGuid,
    rfcMessageId: t.guid,
    fromAddress: t.isFromMe ? ownHandle : other,
    fromName: t.isFromMe ? null : name,
    toAddresses: [t.isFromMe ? other : ownHandle],
    ccAddresses: [],
    subject: name ?? other,
    bodyText: body,
    bodyHtml: null,
    snippet: body.slice(0, 200) || (t.attachments.length > 0 ? `${t.attachments.length === 1 ? "An attachment" : `${t.attachments.length} attachments`}` : null),
    attachmentNames: t.attachments.map((a) => a.filename),
    attachments: t.attachments.map((a, index) => ({
      index,
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
      // The path on this Mac is the id: the bytes are read from it on first open.
      providerAttachmentId: a.path ?? a.guid,
      bytes: null,
    })),
    folder: TEXTS_FOLDER,
    sentAt: t.sentAt,
    // Read in Messages already (2026-09-14): not unopened here.
    ...(t.isRead === undefined ? {} : { read: t.isRead }),
    labelIds: [],
    isFromOperator: t.isFromMe,
  };
}
