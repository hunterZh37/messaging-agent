import { and, eq, isNull } from "drizzle-orm";
import { LABELS } from "../config";
import { now, type Db } from "../db/client";
import { messages, sorts } from "../db/schema";
import type { ImapClient } from "./types";

/**
 * A provider message id is `${folder path}:${uid}`. Folder paths can contain
 * slashes and spaces but the uid is always the tail, so split at the last colon.
 */
export function splitProviderMessageId(providerMessageId: string): { folder: string; uid: number } {
  const at = providerMessageId.lastIndexOf(":");
  const folder = at === -1 ? "" : providerMessageId.slice(0, at);
  const uid = Number(providerMessageId.slice(at + 1));
  if (!folder || !Number.isInteger(uid) || uid <= 0) throw new Error(`not an imap message id: ${providerMessageId}`);
  return { folder, uid };
}

/**
 * The only unattended write to the mailbox. Adds namespaced labels (Gmail) or
 * keywords (everywhere else), never removes flags, never archives, never
 * marks read.
 */
export async function applyImapLabels(
  db: Db,
  imap: ImapClient,
  accountId: string,
  clock: () => number = now,
): Promise<{ labeled: number; failed: number }> {
  const rows = db
    .select({ s: sorts, providerMessageId: messages.providerMessageId })
    .from(sorts)
    .innerJoin(messages, eq(messages.id, sorts.messageId))
    .where(and(isNull(sorts.labeledAt), eq(messages.accountId, accountId)))
    .all();
  if (rows.length === 0) return { labeled: 0, failed: 0 };

  let labeled = 0;
  let failed = 0;
  await imap.connect();
  try {
    for (const { s, providerMessageId } of rows) {
      try {
        const add: string[] = [];
        if (s.wants !== "bin") add.push(LABELS.important);
        if (s.wants === "reply") add.push(LABELS.needsReply);
        if (add.length) {
          const { folder, uid } = splitProviderMessageId(providerMessageId);
          await imap.addLabels(folder, uid, add);
        }
        db.update(sorts).set({ labeledAt: clock() }).where(eq(sorts.messageId, s.messageId)).run();
        labeled++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`imap labels: failed for ${providerMessageId}: ${message}`);
        failed++;
      }
    }
  } finally {
    await imap.close();
  }
  return { labeled, failed };
}
