import { and, eq, isNull } from "drizzle-orm";
import { OUTLOOK_CATEGORIES } from "../config";
import { now, type Db } from "../db/client";
import { messages, sorts } from "../db/schema";
import type { OutlookClient } from "./types";

/**
 * The only unattended write to Outlook. Adds namespaced categories, never
 * removes existing ones, never archives, never marks read.
 */
export async function applyOutlookCategories(db: Db, client: OutlookClient, accountId: string, clock: () => number = now): Promise<{ labeled: number; failed: number }> {
  const rows = db
    .select({ s: sorts, providerMessageId: messages.providerMessageId })
    .from(sorts)
    .innerJoin(messages, eq(messages.id, sorts.messageId))
    .where(and(isNull(sorts.labeledAt), eq(messages.accountId, accountId)))
    .all();
  if (rows.length === 0) return { labeled: 0, failed: 0 };

  await client.ensureCategory(OUTLOOK_CATEGORIES.important);
  await client.ensureCategory(OUTLOOK_CATEGORIES.needsReply);

  let labeled = 0;
  let failed = 0;
  for (const { s, providerMessageId } of rows) {
    try {
      const add: string[] = [];
      if (s.important) add.push(OUTLOOK_CATEGORIES.important);
      if (s.needsReply) add.push(OUTLOOK_CATEGORIES.needsReply);
      if (add.length) await client.addCategories(providerMessageId, add);
      db.update(sorts).set({ labeledAt: clock() }).where(eq(sorts.messageId, s.messageId)).run();
      labeled++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`outlook labels: failed for ${providerMessageId}: ${message}`);
      failed++;
    }
  }
  return { labeled, failed };
}
