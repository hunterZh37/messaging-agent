import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { ATTACHMENT_EXCERPT_LIMIT, ingestFile, megabytes } from "../attachments/ingest";
import type { Config } from "../config";
import { now, type Db } from "../db/client";
import { draftAttachments, drafts, type DraftAttachmentRow } from "../db/schema";

/**
 * Outgoing attachments on a draft (spec 8, 2026-09-10). The operator drops a
 * file on the Ask panel or the card and it is theirs from that moment:
 * written to the blob store, listed on the card, and sent with the reply when
 * they press Send. Nothing here reaches a provider, and nothing deletes bytes
 * — blobs are content-addressed and shared, so a file that came off one draft
 * may still be another's.
 */

/** What one mail may carry from here. Past this the providers start refusing anyway. */
export const MAX_DRAFT_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** How many files one draft may carry. A reply with eleven attachments is a mistake, not a reply. */
export const MAX_DRAFT_ATTACHMENTS = 10;

/** How much of a PDF Celeste is shown, under the name the draft code has always used. */
export const DRAFT_ATTACHMENT_EXCERPT_LIMIT = ATTACHMENT_EXCERPT_LIMIT;

/**
 * One file onto a pending draft. The bytes go to the blob store first, so a
 * row never points at a file that is not there; the excerpt is read on the
 * way in, because the point of attaching it in front of Celeste is that she
 * can say what it is.
 */
export async function addDraftAttachment(
  db: Db,
  cfg: Config,
  draftId: string,
  file: { filename: string; mimeType: string; bytes: Buffer },
  clock: () => number = now,
): Promise<DraftAttachmentRow> {
  const draft = db.select().from(drafts).where(eq(drafts.id, draftId)).get();
  if (!draft) throw new Error(`draft not found: ${draftId}`);
  if (draft.status !== "pending") throw new Error(`draft ${draftId} is not pending (status=${draft.status})`);
  if (file.bytes.byteLength > MAX_DRAFT_ATTACHMENT_BYTES) {
    throw new Error(`${file.filename} is ${megabytes(file.bytes.byteLength)}; a draft takes files up to ${megabytes(MAX_DRAFT_ATTACHMENT_BYTES)}.`);
  }
  if (listDraftAttachments(db, draftId).length >= MAX_DRAFT_ATTACHMENTS) {
    throw new Error(`A draft carries at most ${MAX_DRAFT_ATTACHMENTS} files.`);
  }

  const { sha256, path, textExcerpt } = await ingestFile(cfg, file);
  const row: DraftAttachmentRow = {
    id: randomUUID(),
    draftId,
    filename: file.filename,
    mimeType: file.mimeType,
    size: file.bytes.byteLength,
    sha256,
    path,
    textExcerpt,
    createdAt: clock(),
  };
  db.insert(draftAttachments).values(row).run();
  return row;
}

/** What a draft is carrying, in the order the operator attached it. */
export function listDraftAttachments(db: Db, draftId: string): DraftAttachmentRow[] {
  return db.select().from(draftAttachments).where(eq(draftAttachments.draftId, draftId)).orderBy(asc(draftAttachments.createdAt)).all();
}

/**
 * One file on one draft, for the route that serves its bytes back (spec 8,
 * 2026-09-10). The draft id is part of the question rather than a thing to
 * check afterwards: an attachment id that belongs to another draft is a miss,
 * so a guessed id can never reach a file the operator is not looking at.
 */
export function getDraftAttachment(db: Db, draftId: string, attachmentId: string): DraftAttachmentRow | null {
  const row = db.select().from(draftAttachments).where(eq(draftAttachments.id, attachmentId)).get();
  return row && row.draftId === draftId ? row : null;
}

/**
 * The × on a chip. The row goes; the blob stays, because the same bytes may
 * be on another draft or on a message already in the mailbox (spec 11a).
 */
export function removeDraftAttachment(db: Db, draftId: string, attachmentId: string): void {
  const row = db.select().from(draftAttachments).where(eq(draftAttachments.id, attachmentId)).get();
  if (!row || row.draftId !== draftId) throw new Error(`attachment not found on draft ${draftId}: ${attachmentId}`);
  db.delete(draftAttachments).where(eq(draftAttachments.id, attachmentId)).run();
}
