import Link from "next/link";
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { listProjects, type CategoryRow, type Db, type ProjectRow } from "@messaging-agent/core";
import { FOLDER_TITLES, STATUS_LABELS, viewHref, type FolderKey, type FolderStatus, type ViewParams } from "@/lib/folders";
import { allTab, ALL_TAB, groupRow, projectTabs, projectTabsByInbox, type GroupLike, type InboxTabs, type Tab } from "@/lib/tabs";
import {
  PROJECT_COOKIE,
  selectedProject,
  selectedWindow,
  WINDOW_COOKIE,
  WINDOWS,
  type FinanceKey,
  type WindowKey,
} from "@/lib/selection";
import { SyncButton } from "../queue/sync";
import { CategoryEditor } from "./CategoryEditor";
import { ProjectEditor } from "./ProjectEditor";
import { EditorDialog } from "./EditorDialog";
import { HeaderChips, type HeaderChip } from "./HeaderChips";
import { PencilIcon } from "./icons";
import { DeleteAll } from "./DeleteAll";
import { MarkAllOpened } from "./MarkAllOpened";
import { ProjectStrip } from "./ProjectStrip";
import { ProjectPicker } from "./ProjectPicker";
import { PeriodPicker } from "./PeriodPicker";

/** The window chips, in the order they sit in (spec 5). */
const WINDOW_LABELS: Record<WindowKey, string> = { today: "Today", "7d": "7 days", "30d": "30 days", all: "All" };
const WINDOW_CHIPS = WINDOWS.map((window) => ({ window, label: WINDOW_LABELS[window] }));

/**
 * One header across the whole content area, above both panes, holding every
 * control the view has (spec 10a, 10d). Two rows, read top to bottom:
 *
 * 1. **What you are looking at** — the folder, then the selected inbox's
 *    projects as underline tabs on one line that scrolls sideways, in the
 *    operator's order, each counting the messages beneath it. Then Edit,
 *    pinned outside the scroll, and the refresh control at the far right.
 * 2. **How you are looking at it** — the window and the money side, each a
 *    segmented group on its own track under its own label, then "Re-sort
 *    window" at the far right.
 *
 * One visual grammar per axis, which is the point (spec 10a): tabs are what
 * the mail is about, tracks are how it is being narrowed, and neither is
 * mistakable for the other. What is actually applied is said once more
 * underneath, in the line this header does not draw.
 *
 * Every chip stays where it is whatever its count: an empty one goes quiet
 * rather than disappearing, so the row never rearranges itself under the
 * operator's hand. The dimensions combine — a project, a money side, a
 * window and the tree's child row all narrow the same list at once — and
 * each link changes its own and carries the rest.
 *
 * Both editors open as a dialog over the page, so opening one moves nothing.
 *
 * Under All inboxes the project bar keeps every inbox's projects rather than
 * going away (operator, 2026-09-10: "the projects for each inbox should still
 * show but they should be categorized under different mailboxes"), folded
 * behind one pill per inbox after the operator called the unfolded version
 * messy the same day: `ProjectBar` draws that first row and the rows the
 * operator opens. A tab there narrows the list to that project and leaves the
 * switcher on All.
 */
export function ContentHeader(props: {
  folder: FolderKey;
  /** The tree's child row, when one narrows the list. */
  status?: FolderStatus;
  /** The page the header is on, so a link keeps it rather than jumping to a folder. */
  pathname: string;
  /** The whole state of the view, which every link here carries but one param of. */
  params: ViewParams;
  /** The selected inbox, or undefined under All inboxes. */
  accountId: string | undefined;
  /** The inbox switcher, built on the server; it leads the header's filters (2026-09-15). */
  switcher?: ReactNode;
  projects: ProjectRow[];
  /** The groups those projects sit in (2026-09-15). */
  groups: GroupLike[];
  /**
   * One row of the project bar per inbox, under All inboxes; empty when the
   * switcher has picked one, which draws that inbox's projects on its own.
   */
  projectGroups: InboxTabs[];
  /**
   * Counts by project id, plus `unfiled` and `all`, from `countByProject`
   * over the switcher's inbox — every inbox at once under All, so the All
   * tab's number is the length of the list it opens.
   */
  projectCounts: Record<string, number>;
  /** The chosen project id or `unfiled`; undefined for All projects. */
  project: string | undefined;
  /**
   * Operator sub-categories in priority order. Nothing in the header lists
   * them any more: the row of chips came out, and with it the only link to
   * the editor below, which still opens on `?edit=1` for anyone who asks for
   * it by URL. They are still what `?cat=` narrows by and what the row tags
   * show, so the machinery behind them is untouched.
   */
  categories: CategoryRow[];
  /** The chosen sub-category, from a link: nothing in the header sets it. */
  category: string | undefined;
  /** The Finance filter's side, or undefined for both (spec 7). */
  finance: FinanceKey | undefined;
  /** How much of the list beneath is money, each way. */
  financeCounts: { income: number; expense: number };
  /** The window's start in epoch ms, or null for "All": what "Re-sort window" covers. */
  windowStart: number | null;
  /** The chosen time window (spec 5): how far back the list reaches. */
  window: WindowKey;
  /** `?edit=`: `projects` for the project editor, `1` for the sub-categories. */
  edit: string | undefined;
  /**
   * What "Mark all opened" would act on, and how many: only the Unopened view
   * offers it, because only there does marking everything mean one thing.
   */
  unopened?: { scope: import("./actions").UnopenedScope; count: number };
  /**
   * What "Delete all" would act on, and how many threads: only the
   * Safe-to-delete view offers it, because only there does deleting
   * everything mean one thing (spec 10a, 2026-09-11).
   */
  disposable?: { scope: import("./actions").DisposableScope; count: number };
}) {
  const { folder, status, pathname, params, accountId, projects, groups, projectGroups, projectCounts, project } = props;
  const { categories, category, window: activeWindow, edit } = props;
  const isInbox = folder === "inbox";
  const href = (change: Partial<ViewParams>) => viewHref(pathname, { ...params, ...change });

  // Each row of chips owns one dimension: its href sets that one and leaves
  // every other param of the view exactly as it found it.
  const linked = (tabs: Tab[], param: "project" | "fin"): HeaderChip[] =>
    tabs.map(({ children, ...t }) => ({
      ...t,
      href: href({ [param]: t.value ?? undefined }),
      to: href({ [param]: undefined }),
      // A group's projects, linked the same way, for the phone's sheet (2026-09-15).
      ...(children ? { children: linked(children, param) } : {}),
    }));

  // Under All inboxes: one pill per inbox that still has something to show.
  const inboxRows = accountId ? [] : projectTabsByInbox(projectGroups, project, params.inbox);
  // The single inbox's tabs, and the row of a group's projects beneath the bar
  // while that group or one of its projects is on (2026-09-15).
  // Only what holds mail in this period is offered, here and in the panel
  // (operator, 2026-09-15: "if projects is zero, don't show it"); the one
  // that is on always shows, or it could not be switched off.
  const singleTabs = accountId ? projectTabs(projects, projectCounts, project, groups) : [];
  const openGroup = accountId ? groupRow(singleTabs) : (inboxRows.map((r) => groupRow(r.tabs)).find(Boolean) ?? null);

  // The phone's project picker (2026-09-15), under All inboxes: the same All
  // as the bar, then every inbox with all of its projects, so it is there
  // even on a list that holds nothing.
  const allInboxesChip: HeaderChip = {
    ...linked([allTab(projectCounts[ALL_TAB] ?? 0, project)], "project")[0]!,
    on: !project && !params.inbox,
    href: href({ project: undefined, inbox: undefined }),
    to: href({ project: undefined, inbox: undefined }),
  };
  const allInboxesPicker = accountId ? null : (
    <ProjectPicker
      allChip={allInboxesChip}
      groups={projectTabsByInbox(projectGroups, project, params.inbox).map((row) => ({
        label: row.label,
        accountId: row.accountId,
        mail: row.mail,
        openHref: href({ inbox: row.accountId, project: undefined }),
        open: row.accountId === params.inbox || row.tabs.some((t) => t.on),
        chips: linked(row.tabs, "project"),
        editHref: href({ account: row.accountId, edit: "projects" }),
      }))}
    />
  );

  const windowChips: HeaderChip[] = WINDOW_CHIPS.map((w) => ({
    key: w.window,
    name: w.label,
    label: w.label,
    href: href({ since: w.window }),
    to: href({ since: undefined }),
    value: w.window,
    on: activeWindow === w.window,
  }));

  return (
    <header className="content-head">
      {/* Under All inboxes the bar is the first row: the All tab, then a pill
          per inbox, and the rows the operator has opened beneath. */}
      {/* The window first, then the projects it counts (operator, 2026-09-15:
          "the window should be above projects"): the title, the window and
          the money side, then the actions and refresh on one row. */}
      <div className="head-row first">
        <span className="head-title">{FOLDER_TITLES[folder]}</span>
        {status ? <span className="head-sub">{STATUS_LABELS[status]}</span> : null}
        <span className="head-div" />
        <div className="head-filters">
          {/* Chats belong to no inbox (spec 10f), so Messages has no INBOX chip. */}
          {folder === "messages" ? null : props.switcher}
          <PeriodPicker chips={windowChips} />
          {/* Chats have no projects (spec 10f). */}
          {folder === "messages" ? null : accountId ? (
            <ProjectPicker
              accountId={accountId}
              allChip={linked(singleTabs, "project")[0]!}
              groups={[{ chips: linked(singleTabs, "project").slice(1), editHref: href({ edit: "projects" }) }]}
            />
          ) : projectGroups.some((g) => g.projects.length > 0) ? (
            allInboxesPicker
          ) : (
            <span className="head-hint">No projects yet. Pick an inbox and press Edit to propose some.</span>
          )}
        </div>
        <span className="head-spacer" />
        {props.unopened ? <MarkAllOpened scope={props.unopened.scope} count={props.unopened.count} /> : null}
        {props.disposable ? <DeleteAll scope={props.disposable.scope} count={props.disposable.count} /> : null}
        <SyncButton />
      </div>

      {/* The group's projects keep their row whether or not one is picked, so
          the list never moves up and down under the hand (operator,
          2026-09-15: "the position of the labels are too jumpy"). */}
      {folder === "messages" ? null : openGroup ? (
        <div className="head-row group-row">
          <span className="head-label group">{openGroup.group.name}</span>
          <ProjectStrip {...(accountId ? { accountId } : {})} chips={linked(openGroup.tabs, "project")} />
        </div>
      ) : (
        <div className="head-row group-row empty" aria-hidden="true" />
      )}

      {accountId && edit === "projects" ? (
        <EditorDialog title="Projects" labelledBy="projects-dialog-title" closeHref={href({ edit: undefined })} returnFocusTo="edit-projects">
          <ProjectEditor
            accountId={accountId}
            projects={projects.map((p) => ({ id: p.id, name: p.name, description: p.description, groupKey: p.groupId }))}
            groups={groups.map((g) => ({ id: g.id, key: g.id, name: g.name }))}
            closeHref={href({ edit: undefined })}
            windowStart={props.windowStart}
          />
        </EditorDialog>
      ) : null}
      {isInbox && edit === "1" ? (
        <EditorDialog
          title="Sub-categories"
          labelledBy="categories-dialog-title"
          closeHref={href({ edit: undefined })}
          returnFocusTo="edit-categories"
        >
          <CategoryEditor
            categories={categories.map((c) => ({ id: c.id, name: c.name, description: c.description }))}
            closeHref={href({ edit: undefined })}
          />
        </EditorDialog>
      ) : null}
    </header>
  );
}
