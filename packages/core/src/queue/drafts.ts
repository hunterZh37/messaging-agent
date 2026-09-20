import { and, asc, eq, gt } from "drizzle-orm";
import { readBlob } from "../attachments/blobs";
import type { Sender } from "../connectors/types";
import { now, type Db } from "../db/client";
import { accounts, drafts, messages, sorts, threads, type AccountRow, type DraftAttachmentRow, type DraftRow, type MessageRow, type SortRow } from "../db/schema";
import { replySubject, validateRecipients } from "../connectors/mime";
import { listDraftAttachments } from "../draft/attachments";
import { hasMarkup, markupToHtml, stripMarkup } from "../text/markup";
import { recordAction } from "./actions";

export interface DraftView {
  draft: DraftRow;
  replyTo: MessageRow;
  thread: MessageRow[];
  account: AccountRow;
  sort: SortRow | null;
  /** Files the operator put on this draft, which go out with it (spec 8, 2026-09-10). */
  attachments: DraftAttachmentRow[];
  /**
   * The subject the send will set, worked out here rather than in the browser
   * so the preview of the mail shows the header the recipient will actually
   * get (spec 8, 2026-09-10).
   */
  replySubject: string;
}

function view(db: Db, draft: DraftRow): DraftView | null {
  const replyTo = db.select().from(messages).where(eq(messages.id, draft.replyToMessageId)).get();
  if (!replyTo) return null;
  const account = db.select().from(accounts).where(eq(accounts.id, replyTo.accountId)).get();
  if (!account) return null;
  const thread = db.select().from(messages).where(eq(messages.threadId, draft.threadId)).orderBy(asc(messages.sentAt)).all();
  const sort = db.select().from(sorts).where(eq(sorts.messageId, replyTo.id)).get() ?? null;
  return { draft, replyTo, thread, account, sort, attachments: listDraftAttachments(db, draft.id), replySubject: replySubject(replyTo.subject) };
}

/**
 * The approval queue, oldest draft first. `accountId` is the inbox switcher's
 * selection (spec 10a): the queue then holds only drafts replying to mail in
 * that inbox.
 */
/**
 * A draft the operator has already answered past is retired (operator,
 * 2026-09-11: no Celeste drafts for sent mail). When the last message in the
 * thread is the operator's own and came after the draft, the reply was
 * written elsewhere, in Gmail or Outlook; the draft goes to skipped so it
 * leaves the queue and the count, and no further token goes on it.
 */
export function retireAnsweredDrafts(db: Db, clock: () => number = now): number {
  const answered = db
    .select({ id: drafts.id })
    .from(drafts)
    .innerJoin(threads, eq(threads.id, drafts.threadId))
    .where(and(eq(drafts.status, "pending"), eq(threads.lastFromOperator, true), gt(threads.lastMessageAt, drafts.createdAt)))
    .all();
  if (answered.length === 0) return 0;
  const t = clock();
  for (const { id } of answered) {
    db.update(drafts).set({ status: "skipped", error: "answered by the operator", updatedAt: t }).where(eq(drafts.id, id)).run();
  }
  return answered.length;
}

export function listPendingDrafts(db: Db, opts: { accountId?: string } = {}): DraftView[] {
  retireAnsweredDrafts(db);
  return db
    .select()
    .from(drafts)
    .where(eq(drafts.status, "pending"))
    .orderBy(asc(drafts.createdAt))
    .all()
    .map((d) => view(db, d))
    .filter((v): v is DraftView => v !== null)
    .filter((v) => !opts.accountId || v.account.id === opts.accountId);
}

export function getDraftView(db: Db, draftId: string): DraftView | null {
  const d = db.select().from(drafts).where(eq(drafts.id, draftId)).get();
  return d ? view(db, d) : null;
}

/**
 * The one path that sends. Reachable only from the queue's send button after
 * confirm and the cancel window. Records an action whether it succeeds or fails.
 */
export async function sendDraft(
  db: Db,
  sender: Sender,
  p: { draftId: string; finalText: string; to: string[]; cc: string[] },
  clock: () => number = now,
): Promise<{ providerMessageId: string }> {
  const v = getDraftView(db, p.draftId);
  if (!v) throw new Error(`draft not found: ${p.draftId}`);
  if (v.draft.status !== "pending") throw new Error(`draft ${p.draftId} is not pending (status=${v.draft.status})`);
  if (p.to.length === 0) throw new Error("at least one To recipient is required");

  const thread = db.select().from(threads).where(eq(threads.id, v.draft.threadId)).get();
  if (!thread) throw new Error(`thread not found: ${v.draft.threadId}`);

  // A mail address has a shape; a text goes to a handle Messages already
  // knows (a number or an Apple ID), which the text sender checks itself
  // (first send, 2026-09-11: "invalid recipient: +1903…").
  if (v.account.provider !== "imessage" && v.account.provider !== "whatsapp") validateRecipients(p.to, p.cc);

  // Read before the send, not during it: a file that has gone missing off
  // disk stops the send with the draft still pending, rather than putting out
  // a reply that says "attached" and carries nothing.
  const attachments = await Promise.all(
    v.attachments.map(async (a) => ({ filename: a.filename, mimeType: a.mimeType, bytes: await readBlob(a.path) })),
  );

  const normalizedList = (xs: string[]) => [...xs].map((x) => x.toLowerCase()).sort();
  const edited =
    p.finalText !== v.draft.originalText ||
    JSON.stringify(normalizedList(p.to)) !== JSON.stringify(normalizedList(v.draft.toAddresses)) ||
    JSON.stringify(normalizedList(p.cc)) !== JSON.stringify(normalizedList(v.draft.ccAddresses));

  // The two halves of what goes out (operator, 2026-09-20). A chat has no
  // HTML to put anywhere, so a marked reply going to Messages or WhatsApp is
  // simply the words: the marks are the operator's note to the renderer, not
  // something anyone should read.
  const chat = v.account.provider === "imessage" || v.account.provider === "whatsapp";
  const marked = !chat && hasMarkup(p.finalText);

  try {
    const sent = await sender.sendReply({
      replyToProviderMessageId: v.replyTo.providerMessageId,
      providerThreadId: thread.providerThreadId,
      from: v.account.email,
      to: p.to,
      cc: p.cc,
      subject: v.replySubject,
      inReplyTo: v.replyTo.rfcMessageId,
      body: stripMarkup(p.finalText),
      ...(marked ? { html: markupToHtml(p.finalText) } : {}),
      attachments,
    });
    const t = clock();
    db.update(drafts)
      .set({ status: "sent", finalText: p.finalText, toAddresses: p.to, ccAddresses: p.cc, sentProviderMessageId: sent.id, updatedAt: t })
      .where(eq(drafts.id, p.draftId))
      .run();
    recordAction(
      db,
      {
        kind: edited ? "edit_send" : "send",
        draftId: p.draftId,
        messageId: v.replyTo.id,
        payload: {
          originalText: v.draft.originalText,
          originalTo: v.draft.toAddresses,
          originalCc: v.draft.ccAddresses,
          finalText: p.finalText,
          to: p.to,
          cc: p.cc,
          providerMessageId: sent.id,
        },
      },
      () => t,
    );
    return { providerMessageId: sent.id };
  } catch (err) {
    const message = (err as Error).message;
    const t = clock();
    try {
      db.update(drafts).set({ status: "failed", error: message, finalText: p.finalText, updatedAt: t }).where(eq(drafts.id, p.draftId)).run();
      recordAction(db, { kind: "send_failed", draftId: p.draftId, messageId: v.replyTo.id, payload: { error: message, finalText: p.finalText, to: p.to, cc: p.cc } }, () => t);
    } catch (bookkeepingError) {
      console.error("sendDraft: failed to record failure:", bookkeepingError);
    }
    throw err;
  }
}

/**
 * Delete a draft (operator, 2026-09-14: "able to delete draft"). Stored as
 * `skipped`, which is what Skip always did: the card goes, the automatic
 * drafter never writes that message again, and "Draft a reply" is back for
 * the operator to ask for a fresh one. `restoreDraft` is its Undo.
 */
export function skipDraft(db: Db, draftId: string, clock: () => number = now): void {
  const v = getDraftView(db, draftId);
  if (!v) throw new Error(`draft not found: ${draftId}`);
  if (v.draft.status !== "pending") throw new Error(`draft ${draftId} is not pending (status=${v.draft.status})`);
  const t = clock();
  db.update(drafts).set({ status: "skipped", updatedAt: t }).where(eq(drafts.id, draftId)).run();
  recordAction(db, { kind: "skip", draftId, messageId: v.replyTo.id, payload: {} }, () => t);
}

/**
 * Undo for a deleted draft (2026-09-14): back to pending, as it was. Refused
 * when the thread already holds another pending draft, which the operator
 * asked for after deleting this one, or when the draft was never deleted.
 */
export function restoreDraft(db: Db, draftId: string, clock: () => number = now): DraftView {
  const v = getDraftView(db, draftId);
  if (!v) throw new Error(`draft not found: ${draftId}`);
  if (v.draft.status !== "skipped") throw new Error(`draft ${draftId} is not deleted (status=${v.draft.status})`);
  const other = db
    .select({ id: drafts.id })
    .from(drafts)
    .where(and(eq(drafts.threadId, v.draft.threadId), eq(drafts.status, "pending")))
    .get();
  if (other) throw new Error("This thread already has a newer draft.");
  const t = clock();
  db.update(drafts).set({ status: "pending", updatedAt: t }).where(eq(drafts.id, draftId)).run();
  recordAction(db, { kind: "restore", draftId, messageId: v.replyTo.id, payload: { from: "skipped" } }, () => t);
  return getDraftView(db, draftId)!;
}
