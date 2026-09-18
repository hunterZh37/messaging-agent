import { desc } from "drizzle-orm";
import { countByFinance, countByProject, listCategories, listInboxMessages, schema } from "@messaging-agent/core";
import { disposableThreadIds, unopenedThreadIds } from "@messaging-agent/core";
import { wholeInbox } from "@/lib/opened";
import { core } from "@/lib/core";
import { FOLDER_PATHS, listLimit, parseStatus, viewHref, type FolderKey, type ViewParams } from "@/lib/folders";
import { shortAccount } from "@/lib/format";
import { Nav } from "../queue/Sidebar";
import { treeCounts } from "../queue/counts";
import { inboxSwitcher } from "../queue/switcher";
import { AddInbox } from "../inboxes/AddInbox";
import { InboxList } from "./InboxList";
import { ListScroll } from "./ListScroll";
import { ContentHeader } from "./ContentHeader";
import { resolveProject, resolveFinance, treeScope, viewSelection } from "./selection";
import { windowStart } from "./shared";
import { inboxProjectCounts } from "@/lib/projectGroups";
import { accountLabels } from "@/lib/selection";
import { financeCountScope, projectCountScope, type ViewScope } from "@/lib/scopes";

export interface FolderSearchParams {
  account?: string;
  cat?: string;
  fin?: string;
  edit?: string;
  since?: string;
  project?: string;
  rows?: string;
  inbox?: string;
  status?: string;
}

/**
 * One folder's page (spec 10a): the content header across the top, then the
 * same list pane for Inbox, Sent, Deleted items and Junk. Every inbound
 * message in the window is listed; the ones the sorter called important wear
 * a dot and their category tag rather than hiding the rest. `/inbox` keeps
 * the Finance filter, which is a verdict on inbound mail; the other three
 * keep the window alone. The project the header picks narrows all four
 * (spec 10d).
 */
export async function FolderPage({ folder, searchParams }: { folder: FolderKey; searchParams: FolderSearchParams }) {
  const { account, cat, fin, edit, since, project, status: statusParam, rows: rowsParam, inbox: inboxParam } = searchParams;
  const { db, cfg } = core();
  const accounts = db.select().from(schema.accounts).all();
  const { selectedId, switcher } = await inboxSwitcher(account);

  if (accounts.length === 0) {
    return (
      <main>
        <div className="empty-wrap">
          <div className="empty-title">Add your first inbox</div>
          <AddInbox microsoftReady={Boolean(cfg.microsoft.clientId)} defaultOpen />
        </div>
        {/* No accounts yet: no window either, so the tree opens on its default. */}
        <Nav counts={treeCounts(selectedId)} />
      </main>
    );
  }

  const isInbox = folder === "inbox";
  // Texts (2026-09-11) have no projects and no money side; their rows delete like inbox rows.
  const isTexts = folder === "messages";
  const status = parseStatus(folder, statusParam);
  // A sort is a verdict on inbound mail, so both of its axes only narrow the inbox.
  // A stale `?cat=` (a name renamed or deleted, or "Income" from when Finance
  // was a sub-category) must not empty the list while the counts ignore it.
  const knownCategories = new Set([...listCategories(db).map((c) => c.name), "Other"]);
  const category = isInbox && cat && knownCategories.has(cat) ? cat : undefined;
  const categories = isInbox ? listCategories(db) : [];
  // What was remembered, before the money side is tested against this view.
  // Nothing downstream may read `remembered.finance`: `effective` is the one
  // the list, the counts, the tree and the buttons all have to agree on.
  // The bar is counted over the switcher's inbox, the folder and the tree's
  // row, before the remembered project is tested against it.
  // Chats have no projects (spec 10f), and counting every text of every
  // chat by project took twelve seconds a page once the history was in
  // (stress loop, 2026-09-11): the Messages folder skips the count.
  // All time: what decides which project tabs show and whether a remembered
  // project still means anything. The numbers on the tabs follow the window
  // (`projectCountsInWindow`, below; operator, 2026-09-15).
  const projectCounts = isTexts ? {} : countByProject(db, projectCountScope({ folder, ...(selectedId ? { accountId: selectedId } : {}), ...(status ? { status } : {}), since: null }));
  const remembered = resolveProject(await viewSelection(db, selectedId, { project, since, fin }), projectCounts, Boolean(project));
  const { projects, project: activeProject, projectId, projectAccountId, window } = remembered;
  // Under All inboxes a chosen project narrows the list to the inbox that
  // owns it, and an inbox's Unfiled says so itself: either way the list, the
  // tree and the money counts are taken over that inbox (spec 10d).
  // An open pill under All inboxes narrows the list to its inbox (operator,
  // 2026-09-11); the switcher's inbox and a chosen project's inbox outrank it.
  const focusId = !selectedId && inboxParam && accounts.some((a) => a.id === inboxParam) ? inboxParam : undefined;
  // Chats live in the Messages account alone, whatever inbox the switcher
  // holds or a remembered project names (2026-09-11: the Safe to delete row
  // counted 2 and listed none): the Messages folder is never narrowed to a
  // mail inbox or a project.
  const listAccountId = isTexts ? undefined : (selectedId ?? projectAccountId ?? focusId);
  // One clock for both: an account assumed to hold the default 7 days must
  // not read as short of the 7-day window by the microseconds between calls.
  const at = Date.now();
  const start = windowStart(window, at);
  const projectCountsInWindow = isTexts ? {} : countByProject(db, projectCountScope({ folder, ...(selectedId ? { accountId: selectedId } : {}), ...(status ? { status } : {}), since: start }));
  // The axes stand in an order (spec 10a): a project is counted over what is
  // above it and nothing beside it, so the money side and the window cannot
  // move the project row; the money side is counted over everything. The bar
  // itself is counted over the switcher's inbox alone — never the one a
  // chosen row names, or its All tab would stop being the whole bar's total.
  const barScope: ViewScope = {
    folder,
    ...(selectedId ? { accountId: selectedId } : {}),
    ...(status ? { status } : {}),
    since: start,
  };
  const viewScope: ViewScope = {
    ...barScope,
    ...(listAccountId ? { accountId: listAccountId } : {}),
    ...(projectId ? { project: projectId } : {}),
  };
  const financeCounts = isInbox ? countByFinance(db, financeCountScope(viewScope)) : { income: 0, expense: 0 };
  // One row of the bar per inbox, under All inboxes only: with one picked,
  // that inbox's own tabs are the whole bar.
  const projectGroups = selectedId || isTexts ? [] : inboxProjectCounts(db, remembered.projectGroups, barScope);
  // A money side is read inside the project it sits in: if this one holds
  // none of it, the side comes off rather than emptying the list. The cookie
  // is cleared by whichever action moved the level above; ignoring it here
  // keeps the render right even before that lands, and on a plain link.
  const effective = resolveFinance(remembered, financeCounts);
  const finance = effective.finance;
  const limit = listLimit(rowsParam);
  const rows = listInboxMessages(db, {
    folder,
    accountId: listAccountId,
    category,
    ...(isInbox && finance ? { finance } : {}),
    ...(status ? { status } : {}),
    ...(projectId && !isTexts ? { projectId } : {}),
    ...(start === null ? {} : { since: start }),
    limit,
  });
  // No backfill on demand and no "Sort older" (operator, 2026-09-14:
  // "eliminate backfill"): a wider window shows what is here, and history
  // only ever filled the triage rows with mail long since dealt with.
  const lastSyncAt = db.select({ at: schema.watermarks.lastSyncAt }).from(schema.watermarks).orderBy(desc(schema.watermarks.lastSyncAt)).get()?.at ?? null;

  // One set of tree counts, read by the sidebar and by "Mark all opened", so
  // the number on that button is the number beside the row it belongs to.
  // An open inbox pill narrows these too, so the number on "Mark all opened"
  // is the number the button acts on (stress loop, 2026-09-11).
  const treeCountsForView = treeCounts(selectedId, { ...treeScope(effective, at), ...(focusId ? { accountId: focusId } : {}) });

  // What "Mark all opened" and "Delete all" act on: the view exactly as it is
  // narrowed. Delete all counts threads rather than rows, because a delete is
  // done to a conversation, so its number is what it would actually remove.
  const bulkScope = {
    ...(listAccountId ? { accountId: listAccountId } : {}),
    ...(start === null ? {} : { since: start }),
    ...(projectId && !isTexts ? { projectId } : {}),
    ...(finance ? { finance } : {}),
  };
  // Chats are safe by a rule and counted over every chat, whatever inbox the
  // switcher holds (2026-09-11), so their scope is the window alone.
  const disposableScope = isTexts ? { folder: "messages" as const, ...(start === null ? {} : { since: start }) } : { ...bulkScope, folder: "inbox" as const };
  const disposableThreads = status === "disposable" ? disposableThreadIds(db, disposableScope).length : 0;

  // Every link in the header carries the whole view but the one param it changes.
  const params: ViewParams = {
    ...(account ? { account } : {}),
    ...(category ? { cat: category } : {}),
    ...(finance ? { fin: finance } : {}),
    since: window,
    ...(status ? { status } : {}),
    ...(activeProject ? { project: activeProject } : {}),
    ...(rowsParam ? { rows: rowsParam } : {}),
    ...(focusId ? { inbox: focusId } : {}),
  };

  return (
    <main className="inbox-page">
      <ContentHeader
        switcher={switcher}
        folder={folder}
        {...(status ? { status } : {})}
        pathname={FOLDER_PATHS[folder]}
        params={params}
        accountId={selectedId}
        projects={projects}
        groups={remembered.groups}
        projectGroups={projectGroups}
        projectCounts={projectCountsInWindow}
        project={activeProject}
        categories={categories}
        category={category}
        finance={finance}
        financeCounts={financeCounts}
        windowStart={start}
        window={window}
        edit={edit}
        {...(status === "unopened"
          ? {
              // The number on the button is the number it acts on: every
              // unopened thread in this inbox, whatever the window chip says
              // (operator, 2026-09-14). The tree's count beside "Unopened"
              // stays the window's, so the two can differ, and the button's
              // is the larger one.
              unopened: isTexts
                ? { scope: { folder: "messages" as const }, count: unopenedThreadIds(db, { folder: "messages" }).length }
                : { scope: bulkScope, count: unopenedThreadIds(db, wholeInbox(bulkScope)).length },
            }
          : {})}
        {...(status === "disposable" ? { disposable: { scope: disposableScope, count: disposableThreads } } : {})}
      />
      <div className="inbox-grid">
        <ListScroll scrollKey={viewHref(FOLDER_PATHS[folder], { ...params, rows: undefined })} className="inbox-list">
          <InboxList
            rows={rows}
            folder={folder}
            params={params}
            window={window}
            lastSyncAt={lastSyncAt}
            deletable={isInbox || isTexts}
            restorable={folder === "trash"}
            handledLeaves={status === "needs_reply"}
            pathname={FOLDER_PATHS[folder]}
            limit={limit}
          />
        </ListScroll>
        <div className="inbox-detail placeholder">
          <span>Select a message.</span>
        </div>
      </div>
      <Nav counts={treeCountsForView} params={params} />
    </main>
  );
}
