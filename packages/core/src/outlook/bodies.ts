import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { messages } from "../db/schema";
import { stripHtml } from "../text/html";
import { sanitizeHtml } from "../text/sanitize";
import type { OutlookClient } from "./types";

export type RefreshBodiesResult = { checked: number; updated: number; failed: number };

/**
 * Re-pulls the body of every message of one Outlook account that was stored
 * without HTML, and keeps the HTML where the sender wrote HTML. Mail synced
 * while the client asked Graph for text (up to 2026-09-11) has no layout and
 * no images; this puts them back without a full re-sync.
 *
 * A message Graph no longer has (404) is left as it is and counted as failed.
 */
export async function refreshOutlookBodies(
  db: Db,
  client: OutlookClient,
  accountId: string,
  opts: { onProgress?: (r: RefreshBodiesResult) => void } = {},
): Promise<RefreshBodiesResult> {
  const rows = db
    .select({ id: messages.id, providerMessageId: messages.providerMessageId })
    .from(messages)
    .where(and(eq(messages.accountId, accountId), isNull(messages.bodyHtml)))
    .all();
  const result: RefreshBodiesResult = { checked: 0, updated: 0, failed: 0 };
  for (const row of rows) {
    result.checked++;
    try {
      const body = await client.getBody(row.providerMessageId);
      if (body.contentType.toLowerCase() === "html" && body.content) {
        db.update(messages)
          .set({ bodyHtml: sanitizeHtml(body.content), bodyText: stripHtml(body.content) })
          .where(eq(messages.id, row.id))
          .run();
        result.updated++;
      }
    } catch {
      result.failed++;
    }
    opts.onProgress?.(result);
  }
  return result;
}
