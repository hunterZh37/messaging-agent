import { inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { messages } from "../db/schema";
import { markRestored, markTrashed, relocate, type TrashResult } from "../queue/trash";
import type { OutlookClient, OutlookFolder } from "./types";

/** A Graph 404: the stored id no longer names anything, because the message moved in Outlook itself. */
function isGone(err: unknown): boolean {
  return /Graph request failed: 404\b/.test((err as Error).message ?? "");
}

/**
 * Moves a message to `destination` by its stored id, and when Graph says that
 * id is gone, finds the message by its Message-ID instead (2026-09-14: five
 * deletes "kept by the provider" were mail already in Deleted Items, deleted
 * in Outlook after Celeste had stored it). Already there counts as done;
 * somewhere else is moved under its current id; gone from the mailbox counts
 * as done too, since there is nothing left to move.
 */
async function moveOrFind(client: OutlookClient, row: { providerMessageId: string; rfcMessageId: string | null }, destination: OutlookFolder): Promise<{ id: string }> {
  try {
    return await client.moveMessage(row.providerMessageId, destination);
  } catch (err) {
    if (!isGone(err) || !row.rfcMessageId) throw err;
    const found = await client.findMessage(row.rfcMessageId);
    if (!found) return { id: row.providerMessageId };
    if (found.folder === destination) return { id: found.id };
    return client.moveMessage(found.id, destination);
  }
}

/**
 * Moves mail to Deleted Items over Graph (spec 10a, 2026-09-11). One call
 * per message, because Graph moves one message at a time; a message it
 * refuses is counted and left where it is rather than throwing away the
 * rest of the batch.
 */
export async function trashOutlookMessages(db: Db, client: OutlookClient, messageIds: string[]): Promise<TrashResult> {
  if (messageIds.length === 0) return { moved: 0, failed: 0 };

  const rows = db.select({ id: messages.id, providerMessageId: messages.providerMessageId, rfcMessageId: messages.rfcMessageId }).from(messages).where(inArray(messages.id, messageIds)).all();
  let failed = messageIds.length - rows.length;
  const trashed: string[] = [];
  // Graph hands the message a new id the moment it changes folder; a
  // restore needs the current one, so it is recorded here rather than
  // waiting on the next sync to notice (spec 10a, 2026-09-11).
  const moves: { id: string; providerMessageId: string }[] = [];
  for (const row of rows) {
    try {
      const moved = await moveOrFind(client, row, "trash");
      trashed.push(row.id);
      moves.push({ id: row.id, providerMessageId: moved.id });
    } catch (err) {
      failed++;
      console.error(`outlook trash: failed for ${row.providerMessageId}: ${(err as Error).message}`);
    }
  }

  relocate(db, moves);
  markTrashed(db, trashed);
  return { moved: trashed.length, failed };
}

/**
 * Moves mail back from Deleted Items to the Inbox over Graph (spec 10a,
 * 2026-09-11): undo delete, the mirror of trashOutlookMessages. Graph hands
 * out yet another new id on the way back, recorded the same way; a message
 * it refuses is counted and left in Trash.
 */
export async function restoreOutlookMessages(db: Db, client: OutlookClient, messageIds: string[]): Promise<TrashResult> {
  if (messageIds.length === 0) return { moved: 0, failed: 0 };

  const rows = db.select({ id: messages.id, providerMessageId: messages.providerMessageId, rfcMessageId: messages.rfcMessageId }).from(messages).where(inArray(messages.id, messageIds)).all();
  let failed = messageIds.length - rows.length;
  const restored: string[] = [];
  const moves: { id: string; providerMessageId: string }[] = [];
  for (const row of rows) {
    try {
      const moved = await moveOrFind(client, row, "inbox");
      restored.push(row.id);
      moves.push({ id: row.id, providerMessageId: moved.id });
    } catch (err) {
      failed++;
      console.error(`outlook restore: failed for ${row.providerMessageId}: ${(err as Error).message}`);
    }
  }

  relocate(db, moves);
  markRestored(db, restored);
  return { moved: restored.length, failed };
}
