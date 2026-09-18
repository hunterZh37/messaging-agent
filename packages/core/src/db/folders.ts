import { and, eq, like, not } from "drizzle-orm";
import type { Db } from "./client";
import { messages } from "./schema";

/**
 * Gives mail stored before folders existed the folder it belongs to
 * (spec 10a). Every old row defaulted to `inbox`; the operator's own mail
 * that did not come from INBOX came from a Sent folder, whichever provider
 * delivered it. Rows a folder-aware sync already filed are left alone, so
 * running this on every process start costs one UPDATE and changes nothing.
 */
export function backfillFolders(db: Db): { moved: number } {
  const result = db
    .update(messages)
    .set({ folder: "sent" })
    .where(
      and(
        eq(messages.isFromOperator, true),
        eq(messages.folder, "inbox"),
        not(like(messages.providerMessageId, "INBOX:%")),
      ),
    )
    .run();
  return { moved: result.changes };
}
