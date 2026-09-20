import type { Wants } from "@messaging-agent/core";
import { STATUS_LABELS, type FolderStatus } from "./folders";

/**
 * The labels across the top of a row (operator, 2026-09-20: "I want the email
 * cards to have labels on top, for project and state").
 *
 * A row already says a great deal quietly, in a dot and a weight, so the
 * labels earn their space by saying what the list the operator is standing in
 * does not. In Safe to Delete every row is safe to delete, and a chip
 * repeating it is furniture: the chip that matches the current filter is left
 * off. In the whole Inbox nothing is filtered, so every row wears its rung.
 */
export type RowTag = { name: string; kind: "state" | "project" };

/** The ladder's own words, the same ones the tree uses. */
export const WANTS_LABELS: Record<Wants, string> = {
  reply: STATUS_LABELS.needs_reply,
  action: STATUS_LABELS.action,
  knowing: STATUS_LABELS.knowing,
  bin: STATUS_LABELS.disposable,
};

/** Which list already says this rung, so the row need not repeat it. */
const SAID_BY: Record<Wants, FolderStatus[]> = {
  reply: ["needs_reply", "owed"],
  action: ["action", "owed"],
  knowing: ["knowing"],
  bin: ["disposable"],
};

export function rowTags(
  row: { unread: boolean; sort: { wants: Wants } | null; project: { id: string; name: string } | null },
  /** `project` is the id the view is filtered by, which is what a link carries. */
  view: { status?: FolderStatus | null; project?: string | null } = {},
): RowTag[] {
  const tags: RowTag[] = [];
  // Unopened is a state of the operator's attention rather than a rung, so it
  // sits beside one rather than instead of it.
  if (row.unread && view.status !== "unopened") tags.push({ name: STATUS_LABELS.unopened, kind: "state" });
  const wants = row.sort?.wants;
  if (wants && !SAID_BY[wants].includes((view.status ?? "") as FolderStatus)) {
    tags.push({ name: WANTS_LABELS[wants], kind: "state" });
  }
  if (row.project && row.project.id !== view.project) tags.push({ name: row.project.name, kind: "project" });
  return tags;
}
