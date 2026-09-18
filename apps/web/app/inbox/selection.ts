import { cookies } from "next/headers";
import { countByFinance, groupKey, type Db, type ProjectGroupRow, type ProjectRow } from "@messaging-agent/core";
import { inboxProjects, type InboxProjects } from "@/lib/projectGroups";
import { financeCountScope } from "@/lib/scopes";
import {
  financeWithMail,
  PROJECT_COOKIE,
  projectScope,
  selectedProject,
  selectedWindow,
  WINDOW_COOKIE,
  type FinanceKey,
  type WindowKey,
} from "@/lib/selection";
import { windowStart } from "./shared";

export interface ViewSelection {
  /** The projects the bar may pick from: the selected inbox's, or every inbox's under All. */
  projects: ProjectRow[];
  /** The groups those projects sit in (2026-09-15): the selected inbox's, or every inbox's under All. */
  groups: ProjectGroupRow[];
  /** Every inbox with its own projects, in switcher order: one row of the bar each. */
  projectGroups: InboxProjects[];
  /** The choice as the bar and the links spell it: a project id, or an inbox's Unfiled. */
  project: string | undefined;
  /** The same choice as the list and every count take it: a project id, or `unfiled`. */
  projectId: string | undefined;
  /** The inbox the choice narrows to, when the choice names one rather than implying it. */
  projectAccountId: string | undefined;
  window: WindowKey;
  finance: FinanceKey | undefined;
}

/**
 * The three remembered dimensions of a view (spec 5, 7, 10d), read in one
 * place from one cookie jar: the window, the money side, and the project,
 * plus the projects to build the bar's tabs from. A link naming any of them
 * wins over what was remembered, for that visit. Under All inboxes the bar
 * holds every inbox's projects, one row each, so any of them can be picked
 * and the choice is remembered under its own owner rather than an inbox's
 * (operator, 2026-09-10).
 */
export async function viewSelection(
  db: Db,
  accountId: string | undefined,
  search: { project?: string; since?: string; fin?: string } = {},
): Promise<ViewSelection> {
  const groups = inboxProjects(db);
  const projects = accountId
    ? (groups.find((g) => g.account.id === accountId)?.projects ?? [])
    : groups.flatMap((g) => g.projects);
  const projectGroupRows = accountId ? (groups.find((g) => g.account.id === accountId)?.groups ?? []) : groups.flatMap((g) => g.groups);
  const jar = await cookies();
  const project = selectedProject(
    search.project,
    jar.get(PROJECT_COOKIE)?.value,
    accountId,
    // A group can be the choice as well as a project (2026-09-15).
    [...projects, ...projectGroupRows.map((g) => ({ id: groupKey(g.id) }))],
    groups.map((g) => g.account.id),
  );
  const scope = projectScope(project);
  return {
    projects,
    groups: projectGroupRows,
    projectGroups: groups,
    project,
    projectId: scope.projectId,
    projectAccountId: scope.accountId,
    window: selectedWindow(search.since, jar.get(WINDOW_COOKIE)?.value),
    // The Income / Expense filter is gone from the header (2026-09-15), so a
    // side remembered from before, or named by an old link, narrows nothing:
    // a filter nobody can see or clear must not hide mail.
    finance: undefined,
  };
}

/**
 * A selection whose money side has been tested against the view it sits in.
 * A remembered side that holds nothing here is dropped, and everything that
 * describes the view — the list, the counts, the tree, the buttons — has to
 * agree on that. The marker property is what stops a caller reaching past
 * `resolveFinance` for the remembered value, which is how the tree came to
 * count one thing while the list showed another.
 */
export interface ResolvedView extends ViewSelection {
  readonly financeResolved: true;
}

/** The selection everything downstream agrees on, given this view's money counts. */
/**
 * A remembered project that holds nothing in this view comes off rather than
 * emptying the list (2026-09-11: a project picked under Inbox followed the
 * operator to Sent, where it had nothing, and the list read "Nothing here
 * with these filters" under a tab saying 0). A project the link itself names
 * stays, since the operator just asked for it. Mirrors the money side rule.
 */
export function resolveProject(view: ViewSelection, projectCounts: Record<string, number>, explicit: boolean): ViewSelection {
  if (!view.projectId || explicit) return view;
  if ((projectCounts[view.projectId] ?? 0) > 0) return view;
  return { ...view, project: undefined, projectId: undefined, projectAccountId: undefined };
}

export function resolveFinance(view: ViewSelection, financeCounts: { income: number; expense: number }): ResolvedView {
  return { ...view, finance: financeWithMail(view.finance, financeCounts), financeResolved: true };
}

/**
 * The same, for a page with no view of its own: the queue and the Inboxes
 * page still draw the tree, so they still have to ask whether the remembered
 * money side means anything in the inbox it would narrow.
 */
export function resolveForTree(db: Db, accountId: string | undefined, view: ViewSelection): ResolvedView {
  const scoped = accountId ?? view.projectAccountId;
  const counts = countByFinance(
    db,
    financeCountScope({
      folder: "inbox",
      ...(scoped ? { accountId: scoped } : {}),
      since: windowStart(view.window),
      ...(view.projectId ? { project: view.projectId } : {}),
    }),
  );
  return resolveFinance(view, counts);
}

/** What the folder tree's counts are taken over: the selection, as core wants it. */
export interface TreeScope {
  since?: number;
  projectId?: string;
  finance?: FinanceKey;
  /**
   * The inbox the project choice names, when it names one. An explicitly
   * selected inbox wins over it; under All inboxes it is what keeps the tree
   * counting the same mail the list shows.
   */
  accountId?: string;
}

/**
 * The selection as a scope for `folderCounts`, so a tree row's number is the
 * length of the list that row opens. "All" has no lower bound, which is a
 * missing `since` rather than a zero.
 */
export function treeScope(view: ResolvedView, at?: number): TreeScope {
  const start = windowStart(view.window, at);
  return {
    ...(start === null ? {} : { since: start }),
    ...(view.projectId ? { projectId: view.projectId } : {}),
    ...(view.projectAccountId ? { accountId: view.projectAccountId } : {}),
    ...(view.finance ? { finance: view.finance } : {}),
  };
}
