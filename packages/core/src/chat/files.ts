import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { ingestFile, megabytes } from "../attachments/ingest";
import type { Config } from "../config";
import { now, type Db } from "../db/client";
import { chatFiles, chats, draftAttachments, drafts, type ChatFileRow, type DraftAttachmentRow } from "../db/schema";
import { listDraftAttachments, MAX_DRAFT_ATTACHMENTS } from "../draft/attachments";

/**
 * Files the operator gives a conversation (spec 10c, 2026-09-10). The + and a
 * drop on the Ask panel work whether or not a draft is open: with a draft they
 * go onto the mail, and without one they land here, where Celeste can read
 * them and say what they are. Nothing here is going anywhere — a file on a
 * conversation is not on a mail until the operator clicks "Attach to draft".
 */

/** What one file may weigh, the same as a draft's: past this the providers refuse anyway. */
export const MAX_CHAT_FILE_BYTES = 25 * 1024 * 1024;

/** How many files one conversation may hold. Past this the prompt is a filing cabinet. */
export const MAX_CHAT_FILES = 20;

/**
 * One file onto a conversation. The bytes go to the blob store first, so a row
 * never points at a file that is not there, and a PDF's text is read on the
 * way in: the whole point of handing Celeste a file is that she can say what
 * it is without anyone opening it.
 */
export async function addChatFile(
  db: Db,
  cfg: Config,
  chatId: string,
  file: { filename: string; mimeType: string; bytes: Buffer },
  clock: () => number = now,
): Promise<ChatFileRow> {
  const chat = db.select().from(chats).where(eq(chats.id, chatId)).get();
  if (!chat) throw new Error(`chat not found: ${chatId}`);
  if (file.bytes.byteLength > MAX_CHAT_FILE_BYTES) {
    throw new Error(`${file.filename} is ${megabytes(file.bytes.byteLength)}; a conversation takes files up to ${megabytes(MAX_CHAT_FILE_BYTES)}.`);
  }
  if (listChatFiles(db, chatId).length >= MAX_CHAT_FILES) {
    throw new Error(`A conversation holds at most ${MAX_CHAT_FILES} files.`);
  }

  const { sha256, path, textExcerpt } = await ingestFile(cfg, file);
  const row: ChatFileRow = {
    id: randomUUID(),
    chatId,
    filename: file.filename,
    mimeType: file.mimeType,
    size: file.bytes.byteLength,
    sha256,
    path,
    textExcerpt,
    createdAt: clock(),
  };
  db.insert(chatFiles).values(row).run();
  return row;
}

/** What a conversation is holding, in the order the operator gave it. */
export function listChatFiles(db: Db, chatId: string): ChatFileRow[] {
  return db.select().from(chatFiles).where(eq(chatFiles.chatId, chatId)).orderBy(asc(chatFiles.createdAt)).all();
}

/**
 * One file in one conversation, for the route that serves its bytes back. The
 * chat id is part of the question rather than a thing to check afterwards, as
 * on a draft: a file id belonging to another conversation is a miss.
 */
export function getChatFile(db: Db, chatId: string, fileId: string): ChatFileRow | null {
  const row = db.select().from(chatFiles).where(eq(chatFiles.id, fileId)).get();
  return row && row.chatId === chatId ? row : null;
}

/** The × on a chip. The row goes; the blob stays, because blobs are shared (spec 11a). */
export function removeChatFile(db: Db, chatId: string, fileId: string): void {
  const row = db.select().from(chatFiles).where(eq(chatFiles.id, fileId)).get();
  if (!row || row.chatId !== chatId) throw new Error(`file not found in chat ${chatId}: ${fileId}`);
  db.delete(chatFiles).where(eq(chatFiles.id, fileId)).run();
}

/**
 * "Attach to draft" on a conversation's chip: the file the operator already
 * gave Celeste goes onto the mail they have open. It is a copy of the row and
 * nothing more — the blob is the same file on disk and the excerpt is the one
 * already read, so nothing is parsed twice and a scanned PDF does not become
 * readable on the second pass. The conversation keeps its own copy: giving a
 * file to Celeste and sending it are two different things.
 *
 * `cfg` is taken for the same shape as `addChatFile`, and deliberately unused:
 * there are no bytes to write here.
 */
export function attachChatFileToDraft(
  db: Db,
  cfg: Config,
  chatId: string,
  fileId: string,
  draftId: string,
  clock: () => number = now,
): DraftAttachmentRow {
  void cfg;
  const file = getChatFile(db, chatId, fileId);
  if (!file) throw new Error(`file not found in chat ${chatId}: ${fileId}`);
  const draft = db.select().from(drafts).where(eq(drafts.id, draftId)).get();
  if (!draft) throw new Error(`draft not found: ${draftId}`);
  if (draft.status !== "pending") throw new Error(`draft ${draftId} is not pending (status=${draft.status})`);
  if (listDraftAttachments(db, draftId).length >= MAX_DRAFT_ATTACHMENTS) {
    throw new Error(`A draft carries at most ${MAX_DRAFT_ATTACHMENTS} files.`);
  }

  const row: DraftAttachmentRow = {
    id: randomUUID(),
    draftId,
    filename: file.filename,
    mimeType: file.mimeType,
    size: file.size,
    sha256: file.sha256,
    path: file.path,
    textExcerpt: file.textExcerpt,
    createdAt: clock(),
  };
  db.insert(draftAttachments).values(row).run();
  return row;
}
