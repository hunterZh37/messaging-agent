import { and, eq, isNotNull, sql } from "drizzle-orm";
import { writeBlob } from "../attachments/blobs";
import type { Config } from "../config";
import { type Db } from "../db/client";
import { attachments, messages, threads, type AccountRow } from "../db/schema";
import { isOperatorMessage, operatorAddresses } from "../accounts/aliases";
import { indexMessageForSearch } from "../chat/search";
import type { NormalizedAttachment, NormalizedMessage } from "./types";
import { hiddenFrom, markTrashed, restoreHidden } from "../queue/trash";
import { markThreadOpenedUpTo } from "../queue/inbox";

export function attachmentRowId(messageId: string, index: number): string {
  return `${messageId}:${index}`;
}

export function messageRowId(accountId: string, providerMessageId: string): string {
  return `${accountId}:${providerMessageId}`;
}

export function threadRowId(accountId: string, providerThreadId: string): string {
  return `${accountId}:${providerThreadId}`;
}

/** The provider id a sent reply is stored under until the sync brings the provider's own copy. */
export const SENT_COPY_PREFIX = "sent-copy:";

/** How far apart a sent reply and the provider's copy of it can be dated and still be one message. */
const SENT_COPY_WINDOW_MS = 30 * 60_000;

/** Whitespace-insensitive, so a provider's reflowed plain text still reads as the reply that was typed. */
function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The reply Celeste stored the moment it was sent, when this message is the
 * provider's copy of it: the same Message-ID (IMAP's SMTP send knows it), or,
 * where the send does not say (Outlook), the operator's message in the same
 * thread, dated close by, whose body starts with what was typed.
 */
function sentCopyFor(db: Db, account: AccountRow, n: NormalizedMessage, threadId: string, isFromOperator: boolean): { id: string } | undefined {
  if (!isFromOperator || n.folder === "trash" || n.providerMessageId.startsWith(SENT_COPY_PREFIX)) return undefined;
  const copies = db
    .select({ id: messages.id, threadId: messages.threadId, rfcMessageId: messages.rfcMessageId, bodyText: messages.bodyText, sentAt: messages.sentAt })
    .from(messages)
    .where(and(eq(messages.accountId, account.id), sql`${messages.providerMessageId} like ${SENT_COPY_PREFIX + "%"}`))
    .all();
  if (n.rfcMessageId) {
    const same = copies.find((c) => c.rfcMessageId === n.rfcMessageId);
    if (same) return same;
  }
  const body = flat(n.bodyText);
  return copies.find((c) => {
    if (c.threadId !== threadId || (c.rfcMessageId && n.rfcMessageId)) return false;
    if (Math.abs(c.sentAt - n.sentAt) > SENT_COPY_WINDOW_MS) return false;
    const typed = flat(c.bodyText).slice(0, 80);
    return typed.length > 0 && body.startsWith(typed);
  });
}

/**
 * Upserts a normalized message and its thread. Shared by every provider's
 * sync so storage semantics (dedupe, thread aggregation) stay identical.
 * Returns true when a new message row was inserted.
 */
export async function storeNormalizedMessage(
  db: Db,
  cfg: Config,
  account: AccountRow,
  n: NormalizedMessage,
  receivedAt: number,
): Promise<boolean> {
  const id = messageRowId(account.id, n.providerMessageId);
  const threadId = threadRowId(account.id, n.providerThreadId);

  // A delete or restore done in the provider's own app moves the message
  // instead of us learning about it through a normal sync (spec 10a,
  // 2026-09-11): if a row with the same Message-ID already sits on the
  // other side of Trash from where this one is arriving, that row moved,
  // so its location is updated in place rather than inserting a second
  // copy under the new id (seen live on an Amazon thread whose old row went
  // dead once the app-side move landed). Neither-trash and both-trash are
  // left alone: a message the operator sent to themselves legitimately
  // sits in Inbox and Sent under one Message-ID, and that is not a move.
  // A message Celeste moved itself is already known under its new provider
  // id, on a row whose own id still names the old one (the row id is the key
  // everything else points at, so it never changes). The sync that follows
  // the move meets the message under that id: the row is the same message,
  // so it is filed where the provider says rather than inserted again (seen
  // live on 2026-09-11: the first Cmd-Z restore came back twice).
  const known = db
    .select({ id: messages.id, folder: messages.folder, threadId: messages.threadId, isFromOperator: messages.isFromOperator })
    .from(messages)
    .where(and(eq(messages.accountId, account.id), eq(messages.providerMessageId, n.providerMessageId)))
    .get();
  if (known) {
    if (known.folder !== n.folder) db.update(messages).set({ folder: n.folder }).where(eq(messages.id, known.id)).run();
    // A delta saying it was read since it was stored (2026-09-14): what
    // the operator read on their phone opens the thread up to it here.
    if (n.read === true && !known.isFromOperator) markThreadOpenedUpTo(db, known.threadId, n.sentAt);
    return false;
  }

  if (n.rfcMessageId) {
    const candidates = db
      .select({ id: messages.id, folder: messages.folder })
      .from(messages)
      .where(and(eq(messages.accountId, account.id), eq(messages.rfcMessageId, n.rfcMessageId)))
      .all();
    const moved = candidates.find((row) => (row.folder === "trash") !== (n.folder === "trash"));
    if (moved) {
      db.update(messages).set({ providerMessageId: n.providerMessageId, folder: n.folder }).where(eq(messages.id, moved.id)).run();
      return false;
    }
    // Hidden here, then deleted in the provider's own app (2026-09-14): the
    // copy arriving in Trash is the hidden message, not a new one. It takes
    // the provider's new id and becomes deleted rather than hidden, so Put
    // back asks the provider for it. Inserted as a second row instead, it was
    // read as the sender writing again, the hidden copy came back to the
    // inbox under an id the provider no longer had, and Delete on it failed.
    if (n.folder === "trash") {
      const hidden = hiddenFrom(db, candidates.filter((row) => row.folder === "trash").map((row) => row.id));
      const row = candidates.find((c) => hidden.has(c.id));
      if (row) {
        db.update(messages).set({ providerMessageId: n.providerMessageId }).where(eq(messages.id, row.id)).run();
        markTrashed(db, [row.id], () => receivedAt);
        return false;
      }
    }
  }

  // Their own mail is theirs whichever of their addresses sent it, and
  // whichever service forwarded it on their behalf (spec 10a).
  const isFromOperator = n.isFromOperator ?? isOperatorMessage(n, operatorAddresses(db));

  // The provider's copy of a reply sent from here (2026-09-15): it takes over
  // the row stored at send time, which keeps its id, rather than showing the
  // reply twice.
  const copy = sentCopyFor(db, account, n, threadId, isFromOperator);
  if (copy) {
    db.update(messages)
      .set({
        providerMessageId: n.providerMessageId,
        rfcMessageId: n.rfcMessageId,
        toAddresses: n.toAddresses,
        ccAddresses: n.ccAddresses,
        subject: n.subject,
        bodyText: n.bodyText,
        bodyHtml: n.bodyHtml,
        snippet: n.snippet,
        attachmentNames: n.attachmentNames,
        folder: n.folder,
        sentAt: n.sentAt,
      })
      .where(eq(messages.id, copy.id))
      .run();
    indexMessageForSearch(db, { id: copy.id, subject: n.subject, fromName: n.fromName, fromAddress: n.fromAddress, bodyText: n.bodyText });
    await storeAttachments(db, cfg, copy.id, n.attachments, receivedAt);
    return false;
  }

  const inserted = db
    .insert(messages)
    .values({
      id,
      accountId: account.id,
      providerMessageId: n.providerMessageId,
      threadId,
      rfcMessageId: n.rfcMessageId,
      fromAddress: n.fromAddress,
      fromName: n.fromName,
      toAddresses: n.toAddresses,
      ccAddresses: n.ccAddresses,
      subject: n.subject,
      bodyText: n.bodyText,
      bodyHtml: n.bodyHtml,
      snippet: n.snippet,
      attachmentNames: n.attachmentNames,
      isFromOperator,
      mentionsOperator: n.mentionsOperator ?? false,
      folder: n.folder,
      sentAt: n.sentAt,
      receivedAt,
    })
    .onConflictDoNothing()
    .run();
  if (inserted.changes === 0) return false;

  // Mail arrives where the operator reads it (operator, 2026-09-20:
  // "everything should appear inside inbox or unopened").
  //
  // There used to be a rule here: a sender whose mail had ever been deleted,
  // and who had never been answered, had their next message put straight into
  // Deleted items. It was written for one sender at a time and then fed by
  // Delete all, which marks every sender in a sweep at once. 285 senders had
  // been silenced that way and 316 messages went to Deleted items on arrival,
  // including a delivery notice and a calendar summary the operator wanted.
  //
  // It was also invisible: the mail was gone from the inbox with nothing
  // saying so, and unstable besides, because hiding files a message under
  // trash locally while the provider still has it in the inbox, so the next
  // sync pulled it back and which one the operator saw depended on timing.
  //
  // Safe to Delete already answers this question, in a list the operator can
  // see and argue with.
  if (!isFromOperator && (n.folder === "inbox" || n.folder === "messages")) {
    // A hidden thread comes back to the sorting lists when they write again (2026-09-15).
    db.update(threads).set({ hiddenAt: null }).where(and(eq(threads.id, threadId), isNotNull(threads.hiddenAt))).run();
    // Only a message that arrived where the operator reads counts as the
    // other side writing again: a copy landing in Trash or Junk does not (2026-09-14).
    const trashed = db.select({ id: messages.id }).from(messages).where(and(eq(messages.threadId, threadId), eq(messages.folder, "trash"))).all().map((r) => r.id);
    if (trashed.length > 0) restoreHidden(db, hiddenFrom(db, trashed));
  }

  // Searchable the moment it lands, so Ask Celeste never answers about a
  // mailbox one sync behind the one on screen (spec 10c).
  indexMessageForSearch(db, { id, subject: n.subject, fromName: n.fromName, fromAddress: n.fromAddress, bodyText: n.bodyText });

  await storeAttachments(db, cfg, id, n.attachments, receivedAt);

  db.insert(threads)
    .values({
      id: threadId,
      accountId: account.id,
      providerThreadId: n.providerThreadId,
      subject: n.subject,
      lastMessageAt: n.sentAt,
      lastFromOperator: isFromOperator,
    })
    .onConflictDoUpdate({
      target: threads.id,
      set: {
        lastMessageAt: sql`max(${threads.lastMessageAt}, ${n.sentAt})`,
        lastFromOperator: sql`case when ${n.sentAt} >= ${threads.lastMessageAt} then ${isFromOperator ? 1 : 0} else ${threads.lastFromOperator} end`,
      },
    })
    .run();

  // Read where it came from (2026-09-14): mail the operator read on their
  // phone, or years ago in Gmail, is not unopened here. The thread is opened
  // up to this message, once the thread row is there to hang it on. Their
  // own mail says nothing about what they have read.
  if (n.read === true && !isFromOperator) markThreadOpenedUpTo(db, threadId, n.sentAt);
  // Their own message is proof they read the thread up to then (operator,
  // 2026-09-14: a chat answered from the phone is not unopened here).
  if (isFromOperator) markThreadOpenedUpTo(db, threadId, n.sentAt);
  return true;
}

/**
 * The reply as it was sent, in its thread at once (operator, 2026-09-15: "when
 * it is sent I want my sent message to appear instantly"). Mail only: the
 * provider's copy otherwise waits for the next sync of Sent, and a chat's
 * sync already reads the text back from the app straight after the send.
 * Stored under a provider id of its own; the sync's copy takes the row over
 * (see `sentCopyFor`). `rfcMessageId` is the Message-ID the send reported,
 * when it reported one.
 */
export async function storeSentReply(
  db: Db,
  cfg: Config,
  input: {
    account: AccountRow;
    providerThreadId: string;
    draftId: string;
    subject: string;
    to: string[];
    cc: string[];
    text: string;
    attachmentNames: string[];
    rfcMessageId: string | null;
    sentAt: number;
  },
): Promise<void> {
  const { account } = input;
  if (account.provider === "imessage" || account.provider === "whatsapp") return;
  await storeNormalizedMessage(
    db,
    cfg,
    account,
    {
      providerMessageId: `${SENT_COPY_PREFIX}${input.draftId}`,
      providerThreadId: input.providerThreadId,
      rfcMessageId: input.rfcMessageId,
      fromAddress: account.email,
      fromName: null,
      toAddresses: input.to,
      ccAddresses: input.cc,
      subject: input.subject,
      bodyText: input.text,
      bodyHtml: null,
      snippet: input.text.replace(/\s+/g, " ").trim().slice(0, 200),
      attachmentNames: input.attachmentNames,
      attachments: [],
      folder: "sent",
      sentAt: input.sentAt,
      labelIds: [],
      isFromOperator: true,
    },
    input.sentAt,
  );
}

/**
 * One row per kept attachment. Bytes the transport already handed over go to
 * disk here (IMAP); Outlook's arrive later through ensureAttachmentBytes. A
 * blob that will not write is logged and left unfetched: the message is worth
 * more than its attachment, and the on-demand path can still fill it in.
 */
async function storeAttachments(db: Db, cfg: Config, messageId: string, list: NormalizedAttachment[], at: number): Promise<void> {
  for (const a of list) {
    let blob: { sha256: string; path: string } | null = null;
    if (a.bytes) {
      try {
        blob = await writeBlob(cfg, a.bytes);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`store: could not write the blob for ${messageId}:${a.index} (${a.filename}): ${message}`);
      }
    }
    db.insert(attachments)
      .values({
        id: attachmentRowId(messageId, a.index),
        messageId,
        index: a.index,
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
        providerAttachmentId: a.providerAttachmentId,
        sha256: blob?.sha256 ?? null,
        path: blob?.path ?? null,
        fetchedAt: blob ? at : null,
      })
      .onConflictDoNothing()
      .run();
  }
}
