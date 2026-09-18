import { inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { messages } from "../db/schema";
import { markRestored, markTrashed, relocate, type TrashResult } from "../queue/trash";
import { splitProviderMessageId } from "./labels";
import type { ImapClient } from "./types";

/**
 * Moves mail to the server's `\Trash` folder (spec 10a, 2026-09-11). The
 * second thing this codebase writes to a mailbox, after the labels, and the
 * first that moves anything: it runs only behind the operator's click and
 * the six seconds after it.
 *
 * A provider message id is `${folder path}:${uid}`, so the uids are grouped
 * by the folder they live in and moved a folder at a time. A folder whose
 * move fails is counted and left alone — mail that is still in the inbox
 * must keep saying so, or the list would show a delete that never happened.
 */
export async function trashImapMessages(db: Db, imap: ImapClient, messageIds: string[]): Promise<TrashResult> {
  if (messageIds.length === 0) return { moved: 0, failed: 0 };

  const rows = db.select({ id: messages.id, providerMessageId: messages.providerMessageId }).from(messages).where(inArray(messages.id, messageIds)).all();
  // By source folder: `{ uid -> our id }`, so a move that works can say
  // exactly which rows to file under Trash.
  const byFolder = new Map<string, Map<number, string>>();
  let failed = messageIds.length - rows.length;
  for (const row of rows) {
    try {
      const { folder, uid } = splitProviderMessageId(row.providerMessageId);
      const held = byFolder.get(folder);
      if (held) held.set(uid, row.id);
      else byFolder.set(folder, new Map([[uid, row.id]]));
    } catch {
      // Not an IMAP id at all: nothing to move, and nothing to file.
      failed++;
    }
  }
  if (byFolder.size === 0) return { moved: 0, failed };

  await imap.connect();
  const trashed: string[] = [];
  // The uid a message moved into is a new location (spec 10a, 2026-09-11): a
  // restore needs it, so it is recorded when the server's UIDPLUS response
  // says what it was. A server with no UIDPLUS gives no map, and the id is
  // left as it was; restore falls back to a Message-ID search for those.
  const moves: { id: string; providerMessageId: string }[] = [];
  try {
    const trash = (await imap.folders()).trash;
    if (!trash) throw new Error("this mailbox has no Trash folder");
    for (const [folder, uids] of byFolder) {
      // Mail already sitting in Trash has arrived: moving it onto itself is
      // an error on some servers and a no-op on the rest.
      if (folder === trash) {
        trashed.push(...uids.values());
        continue;
      }
      try {
        const uidMap = await imap.move(folder, [...uids.keys()], trash);
        for (const [oldUid, ourId] of uids) {
          trashed.push(ourId);
          const newUid = uidMap.get(oldUid);
          if (newUid !== undefined) moves.push({ id: ourId, providerMessageId: `${trash}:${newUid}` });
        }
      } catch (err) {
        failed += uids.size;
        console.error(`imap trash: ${folder} refused the move: ${(err as Error).message}`);
      }
    }
  } finally {
    await imap.close();
  }

  relocate(db, moves);
  markTrashed(db, trashed);
  return { moved: trashed.length, failed };
}

/**
 * Moves mail back from the server's `\Trash` folder to Inbox (spec 10a,
 * 2026-09-11): undo delete, the mirror of trashImapMessages.
 *
 * The stored id is only a hint of where the message still sits: a server
 * with no UIDPLUS never got a new location recorded when the message went
 * to Trash, so the id there is still the pre-delete inbox uid, not a Trash
 * one. Whenever the id does not point into the Trash folder, or the move
 * there throws because the uid is gone, the fallback is a search by
 * Message-ID inside Trash itself, which is the one thing that never moves.
 */
export async function restoreImapMessages(db: Db, imap: ImapClient, messageIds: string[]): Promise<TrashResult> {
  if (messageIds.length === 0) return { moved: 0, failed: 0 };

  const rows = db
    .select({ id: messages.id, providerMessageId: messages.providerMessageId, rfcMessageId: messages.rfcMessageId })
    .from(messages)
    .where(inArray(messages.id, messageIds))
    .all();
  let failed = messageIds.length - rows.length;

  await imap.connect();
  const restored: string[] = [];
  const moves: { id: string; providerMessageId: string }[] = [];
  try {
    const folders = await imap.folders();
    const trash = folders.trash;
    if (!trash) throw new Error("this mailbox has no Trash folder");
    const inbox = folders.inbox;

    // Rows whose stored id already sits in Trash move together, one call,
    // the same as trashImapMessages does it going the other way. Everything
    // else needs the Message-ID fallback below.
    const grouped: { row: (typeof rows)[number]; uid: number }[] = [];
    let fallbackRows: (typeof rows)[number][] = [];
    for (const row of rows) {
      try {
        const { folder, uid } = splitProviderMessageId(row.providerMessageId);
        if (folder === trash) grouped.push({ row, uid });
        else fallbackRows.push(row);
      } catch {
        fallbackRows.push(row);
      }
    }

    if (grouped.length > 0) {
      try {
        const uidMap = await imap.move(
          trash,
          grouped.map((g) => g.uid),
          inbox,
        );
        for (const { row, uid } of grouped) {
          restored.push(row.id);
          const newUid = uidMap.get(uid);
          if (newUid !== undefined) moves.push({ id: row.id, providerMessageId: `${inbox}:${newUid}` });
        }
      } catch (err) {
        console.error(`imap restore: ${trash} refused the move: ${(err as Error).message}`);
        fallbackRows = fallbackRows.concat(grouped.map((g) => g.row));
      }
    }

    for (const row of fallbackRows) {
      if (!row.rfcMessageId) {
        failed++;
        continue;
      }
      const uid = await imap.findByMessageId(trash, row.rfcMessageId);
      if (uid === null) {
        failed++;
        continue;
      }
      try {
        const uidMap = await imap.move(trash, [uid], inbox);
        restored.push(row.id);
        const newUid = uidMap.get(uid);
        if (newUid !== undefined) moves.push({ id: row.id, providerMessageId: `${inbox}:${newUid}` });
      } catch (err) {
        failed++;
        console.error(`imap restore: could not move uid ${uid} for ${row.id}: ${(err as Error).message}`);
      }
    }
  } finally {
    await imap.close();
  }

  relocate(db, moves);
  markRestored(db, restored);
  return { moved: restored.length, failed };
}
