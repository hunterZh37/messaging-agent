import { keepAttachment, type NormalizedAttachment, type NormalizedMessage } from "../connectors/types";
import { stripHtml, stripInvisible } from "../text/html";
import { sanitizeHtml } from "../text/sanitize";
import type { GraphEmailAddress, GraphMessage, OutlookFolder } from "./types";

function address(e: GraphEmailAddress | undefined): string {
  return (e?.emailAddress?.address ?? "").toLowerCase();
}

function name(e: GraphEmailAddress | undefined): string | null {
  return e?.emailAddress?.name ?? null;
}

/**
 * The parts worth keeping, renumbered 0..n. Graph delivers metadata only, so
 * `bytes` stays null and the id it gives us is what fetches them later.
 */
function attachmentsOf(m: GraphMessage): NormalizedAttachment[] {
  const out: NormalizedAttachment[] = [];
  for (const a of m.attachments ?? []) {
    const size = a.size ?? 0;
    if (!keepAttachment({ filename: a.name || null, mimeType: a.contentType || "application/octet-stream", inline: a.isInline === true, size })) continue;
    out.push({
      index: out.length,
      filename: a.name || `attachment-${out.length}`,
      mimeType: (a.contentType || "application/octet-stream").toLowerCase(),
      size,
      providerAttachmentId: a.id ?? null,
      bytes: null,
    });
  }
  return out;
}

export function normalizeGraphMessage(m: GraphMessage, folder: OutlookFolder = "inbox"): NormalizedMessage {
  const isHtml = (m.body?.contentType ?? "").toLowerCase() === "html";
  const content = m.body?.content ?? "";
  const bodyText = content ? (isHtml ? stripHtml(content) : content) : "";
  // Graph hands over the body as the sender wrote it. HTML keeps its images
  // and layout (operator, 2026-09-11: mail with images rendered as gaps and
  // "[logo]" placeholders while the client asked for text); text stays text.
  const bodyHtml = content && isHtml ? sanitizeHtml(content) : null;
  const sentAt = Date.parse(m.sentDateTime ?? m.receivedDateTime ?? "");
  const attachments = attachmentsOf(m);

  return {
    providerMessageId: m.id,
    providerThreadId: m.conversationId ?? m.id,
    rfcMessageId: m.internetMessageId ?? null,
    fromAddress: address(m.from),
    fromName: name(m.from),
    toAddresses: (m.toRecipients ?? []).map(address),
    ccAddresses: (m.ccRecipients ?? []).map(address),
    subject: m.subject ?? "",
    bodyText,
    bodyHtml,
    snippet: m.bodyPreview ? stripInvisible(m.bodyPreview).replace(/\s+/g, " ").trim() : null,
    attachmentNames: attachments.map((a) => a.filename),
    attachments,
    folder,
    sentAt: Number.isNaN(sentAt) ? 0 : sentAt,
    labelIds: m.categories ?? [],
    ...(m.isRead === undefined ? {} : { read: m.isRead }),
  };
}
