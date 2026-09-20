import Link from "next/link";
import { notFound } from "next/navigation";
import { wholeInbox } from "@/lib/opened";
import { countByFinance, countByProject, disposableThreadIds, unopenedThreadIds, getDraftView, getThread, isWaitingReply, listCategories, conversationUsage, findChatFor, listAlexItems, alexConnected, isWhatsappGroup, WHATSAPP_GROUP_REPLY_OFF, listChatMessages, listInboxMessages, UNFILED, schema } from "@messaging-agent/core";
import { core } from "@/lib/core";
import { FOLDER_PATHS, FOLDER_TITLES, listLimit, parseFolder, parseStatus, threadPath, viewHref, type ViewParams } from "@/lib/folders";
import { formatTime, shortAccount } from "@/lib/format";
import { groupByThread, neighbourThread, runAfter } from "@/lib/threads";
import { Nav } from "../../queue/Sidebar";
import { treeCounts } from "../../queue/counts";
import { inboxSwitcher } from "../../queue/switcher";
import { Thread } from "../../queue/Thread";
import { InboxList } from "../InboxList";
import { ChannelIcon } from "../icons";
import { ListScroll } from "../ListScroll";
import { ContentHeader } from "../ContentHeader";
import { resolveProject, resolveFinance, treeScope, viewSelection } from "../selection";
import { windowStart } from "../shared";
import { inboxProjectCounts } from "@/lib/projectGroups";
import { accountLabels } from "@/lib/selection";
import { financeCountScope, projectCountScope, type ViewScope } from "@/lib/scopes";
import { ThreadDraftHost } from "./ThreadDraftHost";
import { PutBackButton } from "./PutBackButton";
import { MarkOpened } from "./MarkOpened";
import { DeleteButton } from "./DeleteButton";
import { ThreadPane } from "./ThreadPane";
import { WaitingButton } from "./WaitingButton";
import { MoveToProject } from "./MoveToProject";
import { AddToAlex, AlexItems } from "./AddToAlex";
import { TextComposer } from "./TextComposer";
import { UnhideButton } from "./UnhideButton";
import { StickToBottom } from "./StickToBottom";
import { ScrollToEnd, ThreadEnd } from "./ScrollToEnd";
import { CelesteMark } from "../../queue/CelesteMark";
import { ContextThread } from "../../ask/AskProvider";

export const dynamic = "force-dynamic";


export default async function ThreadPage({
  params,
  searchParams,
}: {
  params: Promise<{ threadId: string }>;
  searchParams: Promise<{ account?: string; cat?: string; fin?: string; edit?: string; since?: string; project?: string; folder?: string; status?: string; rows?: string; inbox?: string }>;
}) {
  const { threadId: rawThreadId } = await params;
  const threadId = decodeURIComponent(rawThreadId);
  const { account, cat, fin, edit, since, project, folder: folderParam, status: statusParam, rows: rowsParam, inbox: inboxParam } = await searchParams;
  const { db, cfg } = core();

  const view = getThread(db, threadId);
  if (!view) notFound();

  // This thread's conversation with Celeste, so the panel has it before the
  // page is on screen rather than fetching it once the page says which thread
  // it is (spec 10c, 2026-09-10). Only if there is one: opening a thread does
  // not start a conversation, asking does.
  const threadChat = findChatFor(db, { threadId });
  const askChat = threadChat
    ? { chat: threadChat, turns: listChatMessages(db, threadChat.id), usage: conversationUsage(db, threadChat.id) }
    : undefined;

  // Which list the operator came from, so the left pane keeps showing it.
  const folder = parseFolder(folderParam);
  const isInbox = folder === "inbox";
  // Texts (2026-09-11) have no projects and no money side; their rows delete like inbox rows.
  const isTexts = folder === "messages";
  // A chat is a chat wherever it is read, Deleted items included (stress
  // loop, 2026-09-11: a deleted chat's bubbles showed raw handles and "to"
  // lines). The compose box and the chat's actions still need the folder.
  const isChat = isTexts || view.account.provider === "imessage" || view.account.provider === "whatsapp";
  // A WhatsApp group can be read, sorted and filed like any chat, but not
  // replied to: the app never says which group is open (2026-09-16).
  const isWaGroup = view.account.provider === "whatsapp" && isWhatsappGroup(view.thread.providerThreadId);
  const status = parseStatus(folder, statusParam);
  const { selectedId, switcher } = await inboxSwitcher(account);
  const category = isInbox ? cat : undefined;
  const categories = isInbox ? listCategories(db) : [];
  // The header spans this page too, so the list beside the thread is narrowed
  // exactly the way the folder it came from was (spec 5, 7, 10d).
  // What was remembered, before the money side is tested against this view.
  // Nothing downstream may read `remembered.finance`.
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
  // Under All inboxes a chosen project narrows to the inbox that owns it, the
  // same way the folder page reads it (spec 10d).
  const accounts = db.select({ id: schema.accounts.id, email: schema.accounts.email }).from(schema.accounts).all();
  const focusId = !selectedId && inboxParam && accounts.some((a) => a.id === inboxParam) ? inboxParam : undefined;
  // Chats live in the Messages account alone, whatever inbox the switcher
  // holds or a remembered project names (2026-09-11: the Safe to delete row
  // counted 2 and listed none): the Messages folder is never narrowed to a
  // mail inbox or a project.
  const listAccountId = isTexts ? undefined : (selectedId ?? projectAccountId ?? focusId);
  const start = windowStart(window);
  const projectCountsInWindow = isTexts ? {} : countByProject(db, projectCountScope({ folder, ...(selectedId ? { accountId: selectedId } : {}), ...(status ? { status } : {}), since: start }));
  // The axes stand in an order (spec 10a): a project is counted over what is
  // above it and nothing beside it, so the money side and the window cannot
  // move the project row; the money side is counted over everything. The bar
  // is counted over the switcher's inbox alone, never the one a row names.
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
  const projectGroups = selectedId || isTexts ? [] : inboxProjectCounts(db, remembered.projectGroups, barScope);
  // A money side is read inside the project it sits in: if this one holds
  // none of it, the side comes off rather than emptying the list. The cookie
  // is cleared by whichever action moved the level above; ignoring it here
  // keeps the render right even before that lands, and on a plain link.
  const effective = resolveFinance(remembered, financeCounts);
  const finance = effective.finance;
  // Mark all opened and Delete all stay on the header while a thread is
  // open (operator, 2026-09-13: "Delete all buttons disappeared"), over the
  // same scope the folder page gives them.
  const bulkScope = {
    ...(listAccountId ? { accountId: listAccountId } : {}),
    ...(start === null ? {} : { since: start }),
    ...(projectId ? { projectId } : {}),
    ...(finance ? { finance } : {}),
  };
  const disposableScope = isTexts ? { folder: "messages" as const, ...(start === null ? {} : { since: start }) } : { ...bulkScope, folder: "inbox" as const };
  // Mark all opened acts on the whole inbox, every window (2026-09-14).
  const unopenedScope = isTexts ? { folder: "messages" as const } : bulkScope;
  const disposableCount = status === "disposable" ? disposableThreadIds(db, disposableScope).length : 0;
  const unopenedCount = status === "unopened" ? unopenedThreadIds(db, wholeInbox(unopenedScope)).length : 0;
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

  // The thread's pending draft as the queue knows it, so the card under the
  // mail is the same card the Drafts folder shows (spec 10a, 2026-09-10).
  const draftView = view.draft ? getDraftView(db, view.draft.id) : null;

  const latest = view.messages[view.messages.length - 1]!;
  // When this thread leaves the list (No reply needed), the focus moves to
  // its neighbour rather than staying on mail that is no longer there.
  const listOrder = groupByThread(rows).map((g) => g.threadId);
  const neighbour = neighbourThread(listOrder, threadId);
  const latestInbound = [...view.messages].reverse().find((m) => !m.isFromOperator) ?? null;

  // Every link in the header carries the whole view but the one param it
  // changes, `folder` included: it is what keeps this list beside the thread.
  const headerParams: ViewParams = {
    ...(account ? { account } : {}),
    ...(isInbox ? {} : { folder }),
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
      {/* Celeste always sees the thread that is open, and the panel opens on
          that thread's own conversation, fetched here so it paints with the
          page (spec 10c, 2026-09-10). */}
      <ContextThread threadId={threadId} subject={view.thread.subject} chat={askChat} />
      <ContentHeader
        switcher={switcher}
        folder={folder}
        {...(status ? { status } : {})}
        pathname={`/inbox/${encodeURIComponent(threadId)}`}
        params={headerParams}
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
        {...(status === "unopened" ? { unopened: { scope: unopenedScope, count: unopenedCount } } : {})}
        {...(status === "disposable" ? { disposable: { scope: disposableScope, count: disposableCount } } : {})}
      />
      <div className="inbox-grid">
        <ListScroll scrollKey={viewHref(FOLDER_PATHS[folder], { ...headerParams, folder: undefined, rows: undefined })} className="inbox-list with-detail">
          <InboxList
            rows={rows}
            folder={folder}
            params={headerParams}
            window={window}
            selectedThreadId={threadId}
            lastSyncAt={null}
            countScope={treeScope(effective)}
            deletable={isInbox || isTexts}
            restorable={folder === "trash"}
            handledLeaves={status === "needs_reply"}
            pathname={threadPath(threadId)}
            limit={limit}
          />
        </ListScroll>
        <ThreadPane threadId={threadId} statusList={Boolean(status)}>
          <MarkOpened threadId={threadId} />
          <Link href={viewHref(FOLDER_PATHS[folder], { ...headerParams, folder: undefined })} className="inbox-back">
            {`← ${FOLDER_TITLES[folder]}`}
          </Link>
          <h1>{view.thread.subject || "(no subject)"}</h1>
          <div className="meta">
            <ChannelIcon provider={view.account.provider} />
            <span>{shortAccount(view.account.email)}</span>
            <span>·</span>
            <span>{view.messages.length === 1 ? "1 message" : `${view.messages.length} messages`}</span>
            {view.project ? <span className="tag project">{view.project.name}</span> : null}
            <span style={{ marginLeft: "auto" }}>{formatTime(latest.sentAt)}</span>
          </div>
          {view.sort ? (
            <div className="reason">
              <CelesteMark />
              <span>{view.sort.reason}</span>
            </div>
          ) : null}
          <div className="card thread-card">
            <Thread messages={view.messages} initialExpandedId={latest.id} attachments={view.attachments} chat={isChat} />
            {/* A chat has a place to type (operator, 2026-09-11), under the
                newest text, where Messages puts it. */}
            {isTexts && !isWaGroup ? <TextComposer threadId={threadId} name={view.thread.subject || "them"} /> : null}
            {isWaGroup ? <p className="meta group-no-reply">{WHATSAPP_GROUP_REPLY_OFF}</p> : null}
            {/* Where "Scroll to bottom" takes a long thread (2026-09-15). */}
            <ThreadEnd />
            {/* Any chat, a deleted one included, opens at its newest text (2026-09-14). */}
            {isChat ? <StickToBottom threadId={threadId} /> : null}
            {/* The thread's pending draft as a reply card under the mail it
                answers, and then the action row (spec 10a, 2026-09-10): the
                draft is read where the mail is, so there is nothing here to
                open in the queue. */}
            <ThreadDraftHost view={draftView} threadId={threadId} followUp={latest.isFromOperator} text={isTexts} canReply={!isWaGroup}>
              {/* Sent last and asking something: the thread sits in Waiting until the operator says otherwise. */}
              {latest.isFromOperator && (view.thread.waitingDismissedAt || isWaitingReply({ message: latest, thread: view.thread })) ? (
                <WaitingButton
                  threadId={threadId}
                  dismissed={Boolean(view.thread.waitingDismissedAt)}
                  nextHref={neighbour ? viewHref(threadPath(neighbour), { ...headerParams, folder }) : viewHref(FOLDER_PATHS[folder], { ...headerParams, folder: undefined })}
                />
              ) : null}
              {/* Any inbox thread can go, not only the safe-to-delete ones:
                  the sorter says what to look at and the operator decides
                  what goes (spec 10a, 2026-09-11). It goes at once, to the
                  provider's Trash. */}
              {isInbox || isTexts ? (
                <DeleteButton
                  threadId={threadId}
                  following={runAfter(listOrder, threadId)
                    .slice(0, 60)
                    .map((id) => ({ id, href: viewHref(threadPath(id), { ...headerParams, folder }) }))}
                  emptyHref={viewHref(FOLDER_PATHS[folder], { ...headerParams, folder: undefined })}
                />
              ) : null}
              {/* Hidden already: the way back onto the sorting lists (2026-09-15). */}
              {(isInbox || isTexts) && view.thread.hiddenAt ? <UnhideButton threadId={threadId} chat={isChat} /> : null}
              {(isInbox || isTexts) && !view.thread.hiddenAt ? (
                <DeleteButton
                  hide
                  stay={!status}
                  threadId={threadId}
                  following={runAfter(listOrder, threadId)
                    .slice(0, 60)
                    .map((id) => ({ id, href: viewHref(threadPath(id), { ...headerParams, folder }) }))}
                  emptyHref={viewHref(FOLDER_PATHS[folder], { ...headerParams, folder: undefined })}
                />
              ) : null}
              {folder === "trash" ? (
                <PutBackButton
                  threadId={threadId}
                  chat={isChat}
                  nextHref={neighbour ? viewHref(threadPath(neighbour), { ...headerParams, folder }) : viewHref(FOLDER_PATHS[folder], { ...headerParams, folder: undefined })}
                />
              ) : null}
              <MoveToProject
                threadId={threadId}
                accountId={view.account.id}
                projects={view.projects}
                currentId={view.project?.id ?? null}
                unfiledLabel={UNFILED}
              />
              {/* Into the scheduling agent (spec 10e): a to-do, a reminder or
                  an event, written only because the operator pressed Add. */}
              <AddToAlex threadId={threadId} subject={view.thread.subject ?? ""} connected={alexConnected(cfg.alex)} />
            </ThreadDraftHost>
            <AlexItems threadId={threadId} items={listAlexItems(db, threadId)} />
          </div>
          <ScrollToEnd threadId={threadId} />
        </ThreadPane>
      </div>
      <Nav counts={treeCounts(selectedId, treeScope(effective))} params={headerParams} />
    </main>
  );
}
