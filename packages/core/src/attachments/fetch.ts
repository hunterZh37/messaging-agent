import { eq } from "drizzle-orm";
import { simpleParser } from "mailparser";
import type { Config } from "../config";
import type { MailConnector } from "../connectors/types";
import { now, type Db } from "../db/client";
import { accounts, attachments, messages, type AccountRow, type AttachmentRow, type MessageRow } from "../db/schema";
import { imapAttachmentName, keptImapParts } from "../imap/normalize";
import type { ImapClient } from "../imap/types";
import type { OutlookClient } from "../outlook/types";
import { readBlob, writeBlob } from "./blobs";

/** The row, message, or account behind an attachment id is not in the database. Web routes turn this into a 404. */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/**
 * IMAP has no attachment endpoint: the bytes come back by re-fetching the
 * whole message source with BODY.PEEK and re-parsing it. The stored index is
 * only meaningful under the same skip rule the normalizer used, so this
 * reuses that rule and then checks the filename still lines up before handing
 * bytes to anyone.
 */
export async function fetchImapAttachment(imap: ImapClient, providerMessageId: string, att: AttachmentRow): Promise<Buffer> {
  // A folder path may itself contain ":", the uid never does, so split last.
  const cut = providerMessageId.lastIndexOf(":");
  const folder = cut === -1 ? "INBOX" : providerMessageId.slice(0, cut);
  const uid = Number(providerMessageId.slice(cut + 1));
  if (!Number.isFinite(uid)) throw new Error(`Cannot read a uid out of the provider message id ${providerMessageId}`);

  await imap.connect();
  let source: Buffer | null;
  try {
    source = await imap.fetchSource(folder, uid);
  } finally {
    await imap.close();
  }
  if (!source) throw new Error(`Message ${providerMessageId} is no longer on the server`);

  const parsed = await simpleParser(source);
  const part = keptImapParts(parsed)[att.index];
  if (!part) throw new Error(`Message ${providerMessageId} no longer has an attachment at index ${att.index}`);

  const name = imapAttachmentName(part, att.index);
  if (name !== att.filename) {
    throw new Error(`Attachment ${att.index} of ${providerMessageId} is "${name}" now, not "${att.filename}"`);
  }
  return part.content;
}

/** Graph serves attachment bytes directly; the client's auth/refresh path still turns an expired sign-in into AccountAuthError. */
export async function fetchOutlookAttachment(
  client: OutlookClient,
  providerMessageId: string,
  att: AttachmentRow,
  /** Told the attachment's current Graph id when the stored one no longer answers, so the row can keep up. */
  onRelocate?: (providerAttachmentId: string) => void,
): Promise<Buffer> {
  if (!att.providerAttachmentId) throw new Error(`Attachment "${att.filename}" has no Graph attachment id to fetch`);
  try {
    return await client.getAttachmentBytes(providerMessageId, att.providerAttachmentId);
  } catch (err) {
    // Graph renames a message's attachments when the message moves (to
    // Trash, or back), so the id stored at sync stops answering (stress
    // audit, 2026-09-11). The message itself still lists them, in the same
    // order the sync read them: the one at this index, or failing that the
    // one with this name, is the same file under its new id.
    const listed = await client.listAttachments(providerMessageId);
    const atIndex = listed[att.index];
    const byName = listed.filter((a) => a.name === att.filename);
    const again = atIndex && (atIndex.name === att.filename || byName.length !== 1) ? atIndex : byName[0];
    if (!again || again.id === att.providerAttachmentId) throw err;
    const bytes = await client.getAttachmentBytes(providerMessageId, again.id);
    onRelocate?.(again.id);
    return bytes;
  }
}

/**
 * The bytes of one attachment, from disk when they are there and from the
 * provider when they are not. The one path that backfills mail synced before
 * blobs existed, and the only place attachment rows gain a path.
 */
export async function ensureAttachmentBytes(
  db: Db,
  cfg: Config,
  connectorFor: (account: AccountRow) => MailConnector,
  attachmentId: string,
): Promise<{ row: AttachmentRow; message: MessageRow; bytes: Buffer }> {
  const row = db.select().from(attachments).where(eq(attachments.id, attachmentId)).get();
  if (!row) throw new NotFoundError(`No attachment ${attachmentId}`);
  const message = db.select().from(messages).where(eq(messages.id, row.messageId)).get();
  if (!message) throw new NotFoundError(`Attachment ${attachmentId} points at a message that is gone`);
  const account = db.select().from(accounts).where(eq(accounts.id, message.accountId)).get();
  if (!account) throw new NotFoundError(`Attachment ${attachmentId} points at an account that is gone`);

  if (row.path) {
    try {
      return { row, message, bytes: await readBlob(row.path) };
    } catch {
      // The blob was deleted or never landed: fall through and fetch it again.
    }
  }

  const bytes = await connectorFor(account).fetchAttachment(db, account, row);
  const blob = await writeBlob(cfg, bytes);
  const fetchedAt = now();
  db.update(attachments).set({ sha256: blob.sha256, path: blob.path, fetchedAt }).where(eq(attachments.id, attachmentId)).run();

  return { row: { ...row, sha256: blob.sha256, path: blob.path, fetchedAt }, message, bytes };
}
