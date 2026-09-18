import { now, type Db } from "../db/client";
import { actions, type ActionRow } from "../db/schema";

/**
 * Append-only log of every operator action. This module deliberately exports
 * no update or delete. Do not add one.
 *
 * `db` is narrowed to what this needs, so a caller inside a transaction can
 * record through the same gateway rather than reaching for `actions` itself:
 * moving mail to Trash writes the message row and its action together or not
 * at all (spec 10a, 2026-09-11).
 */
export function recordAction(
  db: Pick<Db, "insert">,
  a: { kind: ActionRow["kind"]; draftId?: string; messageId?: string; payload: Record<string, unknown> },
  clock: () => number = now,
): number {
  const r = db
    .insert(actions)
    .values({ kind: a.kind, draftId: a.draftId ?? null, messageId: a.messageId ?? null, payload: a.payload, createdAt: clock() })
    .run();
  return Number(r.lastInsertRowid);
}
