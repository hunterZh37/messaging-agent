import { countByProject, listProjectGroups, listProjects, schema, type Db, type ProjectGroupRow, type ProjectRow } from "@messaging-agent/core";
import { projectCountScope, type ViewScope } from "./scopes";
import { accountLabels } from "./selection";

/** One inbox and the projects it owns, in the operator's order. */
export interface InboxProjects {
  account: { id: string; email: string };
  projects: ProjectRow[];
  /** Its project groups in the operator's order (2026-09-15). */
  groups: ProjectGroupRow[];
}

/** The same, once the view has been counted over it: what one row of the bar draws. */
export interface InboxProjectCounts extends InboxProjects {
  /** The inbox's short name, the one the switcher calls it by. */
  label: string;
  accountId: string;
  /** Counts by project id, plus `unfiled` and `all`, for this inbox alone. */
  counts: Record<string, number>;
}

/**
 * Every inbox's projects, in the order the switcher lists the inboxes in
 * (spec 10d). Under All inboxes the project bar shows all of them at once,
 * one row per inbox, so this is what the bar is built from; under one inbox
 * it is also what says whether a `?project=` names anything real.
 */
export function inboxProjects(db: Db): InboxProjects[] {
  return db
    .select()
    .from(schema.accounts)
    .all()
    // Texts have no projects (2026-09-11).
    .filter((a) => a.provider !== "imessage" && a.provider !== "whatsapp")
    .map((a) => ({ account: { id: a.id, email: a.email }, projects: listProjects(db, a.id), groups: listProjectGroups(db, a.id) }));
}

/**
 * Each inbox's row of the project bar, counted over the view. A row's numbers
 * are taken over that inbox alone, so a tab's count is the length of the list
 * that tab opens and nothing else — the rule the whole header lives by. Both
 * pages that draw the header call this, so the two cannot come to count
 * differently.
 */
export function inboxProjectCounts(db: Db, groups: InboxProjects[], view: ViewScope): InboxProjectCounts[] {
  const labels = accountLabels(groups.map((g) => g.account));
  return groups.map((g) => ({
    ...g,
    accountId: g.account.id,
    label: labels[g.account.id] ?? g.account.email,
    counts: countByProject(db, { ...projectCountScope(view), accountId: g.account.id }),
  }));
}
