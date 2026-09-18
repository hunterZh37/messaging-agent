import type { Db } from "./db/client";
import { accounts, messages, threads, sorts, drafts, actions } from "./db/schema";

/**
 * Dumps the training-relevant tables as newline-delimited JSON:
 * {"table": "...", "row": {...}}. OAuth tokens and watermarks are excluded.
 */
export async function exportJsonl(db: Db, write: (line: string) => void | Promise<void>): Promise<{ lines: number }> {
  const tables = [
    ["accounts", accounts],
    ["messages", messages],
    ["threads", threads],
    ["sorts", sorts],
    ["drafts", drafts],
    ["actions", actions],
  ] as const;
  let lines = 0;
  for (const [name, table] of tables) {
    for (const row of db.select().from(table).all()) {
      await write(JSON.stringify({ table: name, row }));
      lines++;
    }
  }
  return { lines };
}
