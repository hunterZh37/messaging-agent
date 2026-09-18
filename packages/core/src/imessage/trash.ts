import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { messages, threads } from "../db/schema";
import { markRestored, markTrashed, type TrashResult } from "../queue/trash";
import { TEXTS_FOLDER } from "./normalize";
import { handleOfChat } from "./delete";

/** One chat to delete in Messages.app. */
export interface ChatToDelete {
  guid: string;
  handle: string;
  /** What the chat is called here: the contact's name, or the handle. */
  subject: string;
}

/**
 * Deleting a chat in Celeste deletes it in Messages.app too (operator,
 * 2026-09-11: "the messages on the phone are still there"), chat by chat,
 * and hides it here once Messages has let it go. A chat Messages would not
 * delete stays on screen and counts as failed, so the operator sees it
 * rather than believing it gone. Without a `deleteChat` (tests, a Mac with
 * nothing granted) the rows simply move to the trash folder in our
 * database, where Deleted items and Put back work as they do for mail.
 */
export async function trashImessageMessages(
  db: Db,
  messageIds: string[],
  opts: { deleteChat?: (chat: ChatToDelete) => Promise<void> } = {},
): Promise<TrashResult> {
  if (messageIds.length === 0) return { moved: 0, failed: 0 };
  if (!opts.deleteChat) {
    markTrashed(db, messageIds);
    return { moved: messageIds.length, failed: 0 };
  }
  // The ids by chat, so one conversation is deleted once however many of its
  // texts are going.
  const byChat = new Map<string, { chat: ChatToDelete; ids: string[] }>();
  for (let i = 0; i < messageIds.length; i += 400) {
    const rows = db
      .select({ id: messages.id, guid: threads.providerThreadId, subject: threads.subject })
      .from(messages)
      .innerJoin(threads, eq(threads.id, messages.threadId))
      .where(inArray(messages.id, messageIds.slice(i, i + 400)))
      .all();
    for (const r of rows) {
      const entry = byChat.get(r.guid) ?? { chat: { guid: r.guid, handle: handleOfChat(r.guid), subject: r.subject ?? "" }, ids: [] };
      entry.ids.push(r.id);
      byChat.set(r.guid, entry);
    }
  }
  let moved = 0;
  let failed = 0;
  for (const { chat, ids } of byChat.values()) {
    try {
      await opts.deleteChat(chat);
      markTrashed(db, ids);
      moved += ids.length;
    } catch (err) {
      failed += ids.length;
      console.error(`Messages.app kept the chat with ${chat.handle}:`, (err as Error).message);
    }
  }
  return { moved, failed };
}

/**
 * Put back and Undo bring the chat back in Celeste alone: Messages keeps
 * what was deleted in Recently Deleted for thirty days, where the operator
 * can recover it by hand.
 */
export async function restoreImessageMessages(db: Db, messageIds: string[]): Promise<TrashResult> {
  if (messageIds.length === 0) return { moved: 0, failed: 0 };
  markRestored(db, messageIds);
  // markRestored files a message under the inbox; a text lives in its own folder.
  db.update(messages).set({ folder: TEXTS_FOLDER }).where(inArray(messages.id, messageIds)).run();
  return { moved: messageIds.length, failed: 0 };
}
