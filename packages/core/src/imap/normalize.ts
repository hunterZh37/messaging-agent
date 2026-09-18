import { simpleParser, type AddressObject, type Attachment, type ParsedMail } from "mailparser";
import { keepAttachment, type NormalizedAttachment, type NormalizedMessage } from "../connectors/types";
import { now } from "../db/client";
import type { MailFolder } from "../db/schema";
import { stripHtml } from "../text/html";
import { sanitizeHtml } from "../text/sanitize";
import type { ImapMessage } from "./types";

function addresses(field: AddressObject | AddressObject[] | undefined): { address: string; name: string | null }[] {
  const objects = field === undefined ? [] : Array.isArray(field) ? field : [field];
  const out: { address: string; name: string | null }[] = [];
  for (const o of objects) {
    for (const v of o.value ?? []) {
      // Group syntax ("Team: a@x, b@x;") nests the real addresses one level down.
      const members = v.group ?? [v];
      for (const m of members) {
        if (m.address) out.push({ address: m.address.toLowerCase(), name: m.name || null });
      }
    }
  }
  return out;
}

/**
 * Trims and collapses runs of blank lines, the same shape stripHtml produces,
 * so a stored body reads the same whether it arrived as text or as HTML.
 */
function collapse(text: string): string {
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Senders do mislabel an HTML body as text/plain, so the text is sniffed rather than trusted. */
const LOOKS_LIKE_HTML = /<\s*(br|p|div|table|td|tr|span|a|html|body)\b/i;

/** The message's genuine HTML part, or "" when it has none (mailparser sets `html` to `false` in that case). */
function htmlPartOf(parsed: ParsedMail): string {
  return parsed.html === false ? "" : parsed.html ?? "";
}

/**
 * The readable body: the HTML part when there is one, the text part stripped
 * when it is really HTML in disguise, and otherwise the text as written.
 */
function bodyTextOf(parsed: ParsedMail): string {
  const html = htmlPartOf(parsed);
  if (html.trim()) return stripHtml(html);
  const text = parsed.text ?? "";
  if (LOOKS_LIKE_HTML.test(text)) return stripHtml(text);
  return collapse(text);
}

/**
 * The thread key for servers with no thread id of their own: the root of the
 * References chain, else the message being replied to, else the message itself.
 */
export function threadIdFromHeaders(parsed: ParsedMail): string {
  const refs = parsed.references;
  const first = Array.isArray(refs) ? refs[0] : refs?.trim().split(/\s+/)[0];
  return first || parsed.inReplyTo || parsed.messageId || "";
}

/**
 * The parts worth keeping, renumbered 0..n. IMAP hands over the whole RFC822
 * source at sync, so the bytes are already here: they go to disk immediately
 * (spec 11a), important or not.
 */
export function keptImapParts(parsed: ParsedMail): Attachment[] {
  return (parsed.attachments ?? []).filter((a) =>
    keepAttachment({
      filename: a.filename || null,
      mimeType: a.contentType || "application/octet-stream",
      inline: a.contentDisposition === "inline",
      size: a.size ?? a.content?.length ?? 0,
    }),
  );
}

/** The filename an attachment row carries, so a later fetch can check it still lines up. */
export function imapAttachmentName(part: Attachment, index: number): string {
  return part.filename || `attachment-${index}`;
}

function attachmentsOf(parsed: ParsedMail): NormalizedAttachment[] {
  return keptImapParts(parsed).map((a, index) => ({
    index,
    filename: imapAttachmentName(a, index),
    mimeType: (a.contentType || "application/octet-stream").toLowerCase(),
    size: a.size ?? a.content?.length ?? 0,
    providerAttachmentId: null,
    bytes: a.content ?? null,
  }));
}

/**
 * Turns one raw RFC822 message into the shape core stores. `folder` is the
 * IMAP path it came from: uids are only unique within a folder, so it prefixes
 * the provider message id. `folderKey` is which of the four mailboxes that
 * path is (spec 10a), which the path alone does not say.
 */
export async function normalizeImapMessage(
  m: ImapMessage,
  folder: string,
  clock: () => number = now,
  folderKey: MailFolder = "inbox",
): Promise<NormalizedMessage> {
  const parsed = await simpleParser(m.source);
  const from = addresses(parsed.from)[0] ?? { address: "", name: null };
  const bodyText = bodyTextOf(parsed);
  const html = htmlPartOf(parsed);
  const bodyHtml = html.trim() ? sanitizeHtml(html) : null;
  const attachments = attachmentsOf(parsed);

  return {
    providerMessageId: `${folder}:${m.uid}`,
    providerThreadId: m.gmailThreadId ?? threadIdFromHeaders(parsed),
    rfcMessageId: parsed.messageId ?? null,
    fromAddress: from.address,
    fromName: from.name,
    toAddresses: addresses(parsed.to).map((a) => a.address),
    ccAddresses: addresses(parsed.cc).map((a) => a.address),
    subject: parsed.subject ?? "",
    bodyText,
    bodyHtml,
    snippet: bodyText.slice(0, 200),
    attachmentNames: attachments.map((a) => a.filename),
    attachments,
    folder: folderKey,
    sentAt: parsed.date?.getTime() ?? clock(),
    labelIds: m.gmailLabels ?? [],
    ...(m.seen === undefined ? {} : { read: m.seen }),
  };
}
