import { Fragment } from "react";
import Link from "next/link";
import { listProjects, listSenderRules, listsOfMessages, senderKey, UNFILED, type InboxRow, type ProjectRow, type TreeScope, type Wants } from "@messaging-agent/core";
import { core } from "@/lib/core";
import { ListKeys } from "./ListKeys";
import { FOLDER_TITLES, LIST_PAGE, parseStatus, threadPath, viewHref, type FolderKey, type ViewParams } from "@/lib/folders";
import { formatTime, relativeTime, shortAccount, cleanSnippet } from "@/lib/format";
import type { WindowKey } from "@/lib/selection";
import { groupByThread } from "@/lib/threads";
import { treeKeyForList } from "@/lib/listAdjust";
import { rowTags } from "@/lib/rowTags";
import { ChannelIcon } from "./icons";
import { ThreadGroup } from "./ThreadGroup";
import { TrashRow } from "./TrashRow";
import { RestoreRow } from "./RestoreRow";
import { ListSeen } from "./ListSeen";
import { NewBadge } from "./NewBadge";
import { ListCount } from "./ListCount";
import { RowLink } from "./RowLink";


/**
 * One message. Every row of a thread opens the same thread, newest or oldest.
 * A thread with something in it the operator has not seen wears a dot in the
 * left gutter and a heavier sender, which is what a dot on a mail row has
 * always meant; importance says so in the thread itself and in the tree.
 */
function Row(props: { row: InboxRow; folder: FolderKey; params: ViewParams; selectedThreadId?: string; listKey: string }) {
  const { row: r, folder, params, selectedThreadId, listKey } = props;
  // A chat reads as a chat wherever it is listed, Deleted items included
  // (stress loop, 2026-09-11: a deleted chat's row showed the operator's own
  // handle as its sender).
  const chat = folder === "messages" || r.account.provider === "imessage" || r.account.provider === "whatsapp";
  // Only the inbox proper carries them: Sent, Deleted items and the chat list
  // are not sorted mail, and a rung on one of those rows would say nothing.
  const tags = folder === "inbox" ? rowTags(r, { status: parseStatus(folder, params.status) ?? null, project: params.project ?? null }) : [];
  return (
    <RowLink
      href={viewHref(threadPath(r.thread.id), { ...params, folder })}
      threadId={r.thread.id}
      unread={r.unread}
      receivedAt={r.message.receivedAt}
      selected={r.thread.id === selectedThreadId}
    >
      <div className="meta">
        <ChannelIcon provider={r.account.provider} />
        <span>{shortAccount(r.account.email)}</span>
        {/* Your own last word is not news to you. */}
        {r.message.isFromOperator ? null : <NewBadge listKey={listKey} threadId={r.thread.id} receivedAt={r.message.receivedAt} selected={r.thread.id === selectedThreadId} />}
        {/* Hidden from the sorting lists, still here (2026-09-15). */}
        {r.thread.hiddenAt ? <span className="hidden-tag">Hidden</span> : null}
        <span style={{ marginLeft: "auto" }}>{formatTime(r.message.sentAt)}</span>
      </div>
      {/* Where this one stands and what it is about (operator, 2026-09-20),
          minus whatever the list the operator is standing in already says.
          On their own row rather than among the meta: a project can be named
          anything, and in the meta a long one pushed the clock off its line. */}
      {tags.length > 0 ? (
        <div className="row-tags">
          {tags.map((t) => (
            <span key={`${t.kind}:${t.name}`} className={`row-tag ${t.kind}`}>{t.name}</span>
          ))}
        </div>
      ) : null}
      <div className="inbox-sender">
        {/* Sent mail is read by who it went to, not who wrote it. */}
        <span>{folder === "sent" ? `to ${r.message.toAddresses[0] ?? "(no recipient)"}` : chat ? r.message.subject : (r.message.fromName ?? r.message.fromAddress)}</span>
      </div>
      {/* A chat is named after the person, so the name is the sender line and
          the subject line would only repeat it; a text of the operator's own
          reads "You:" the way Messages shows it. */}
      {chat ? null : <div className="inbox-subject">{r.message.subject || "(no subject)"}</div>}
      <div className="oneline">
        {chat && r.message.isFromOperator ? "You: " : ""}
        {cleanSnippet(r.message.snippet ?? r.message.bodyText.slice(0, 200))}
      </div>
    </RowLink>
  );
}

/**
 * The left pane on every folder page and on `/inbox/[threadId]`: the messages
 * themselves, and nothing else. Every control that decides which messages
 * these are — the folder, the project, the money side, the window and the
 * tree's child row — lives in the content header and the tree beside it
 * (spec 10a, 10d), so the list is a list.
 *
 * One row per thread, not per message: a reply and the message it answers are
 * one conversation, and six of them side by side read as six pieces of mail
 * that happen to share a subject. The rest fold under the newest.
 */
export function InboxList(props: {
  rows: InboxRow[];
  /** Which folder this list is (spec 10a); a row's link carries it to the thread. */
  folder: FolderKey;
  /**
   * The whole view the rows sit in. A row link opens the thread with all of
   * it intact, so the left pane beside the thread is the same list the
   * operator clicked out of.
   */
  params: ViewParams;
  /** The chosen time window (spec 5), which says why an empty list is empty. */
  window: WindowKey;
  selectedThreadId?: string;
  lastSyncAt: number | null;
  /** The scope the tree's counts were read with, so what is taken off them matches. */
  countScope?: TreeScope;
  /**
   * Every row carries an × that deletes its thread (spec 10a, 2026-09-11).
   * Only the Safe-to-delete view asks for it: elsewhere the thread page's
   * Delete is the one place a delete starts, so an ordinary list cannot lose
   * mail to a mis-aimed click.
   */
  /**
   * Rows carry an × and leave the list the moment they are deleted. On in
   * every inbox view, not only Safe to delete (operator, 2026-09-11: "make
   * the delete fast for other places like inbox, need to reply, unopened").
   */
  deletable?: boolean;
  /** Deleted items: each row carries a Restore (2026-09-15). */
  restorable?: boolean;
  /** Where "Show older" goes: this list's own path, so the link keeps the view and asks for more. */
  pathname: string;
  /**
   * How many messages the page read. When the list holds that many, there
   * may be older ones, and "Show older" reads a page more (operator,
   * 2026-09-11: All time used to stop silently at the newest hundred).
   */
  limit: number;
  /** True on the Need-to-reply list, where a thread marked handled leaves (operator, 2026-09-11: Shift). */
  handledLeaves?: boolean;
}) {
  // Named `activeWindow` so nothing here reads like the browser's `window`.
  const { rows, folder, params, window: activeWindow, selectedThreadId } = props;
  // One "last looked" per list: the folder and its row, whatever the window.
  const listKey = `${folder}:${params.status ?? ""}`;

  // The × sits beside the link rather than inside it, and the whole row goes
  // quiet while the gate holds the thread.
  // Every row is keyed by its message, the newest one included: ThreadGroup
  // lays them out as one array, and React asks for a key on each.
  // The standing rules, read once for the whole list rather than per row:
  // the checkbox on a row's Move menu has to show whether this sender is
  // already ruled on (operator, 2026-09-20: it "is automatically off even
  // though I turned it on"). sender_rules holds one row per ruled sender, so
  // this is a small read however long the list is.
  const ruled = new Map<string, Wants>(listSenderRules(core().db).map((r) => [r.fromAddress, r.wants]));
  // senderKey, not a local lowercase: a rule is written under that key, and a
  // From with a display name in it would otherwise miss the rule it has.
  const ruleFor = (from: string) => ruled.get(senderKey(from)) ?? null;

  // A project belongs to one inbox, so a row can only be filed among its own
  // inbox's projects. Read once per inbox on the page rather than per row:
  // under All inboxes a list can hold mail from several.
  const projectsByAccount = new Map<string, ProjectRow[]>();
  const projectsFor = (accountId: string) => {
    let found = projectsByAccount.get(accountId);
    if (!found) {
      found = listProjects(core().db, accountId);
      projectsByAccount.set(accountId, found);
    }
    return found;
  };

  const row = (r: InboxRow) => {
    const key = r.message.id;
    const link = <Row row={r} folder={folder} params={params} listKey={listKey} {...(selectedThreadId ? { selectedThreadId } : {})} />;
    if (props.restorable) {
      const chat = r.account.provider === "imessage" || r.account.provider === "whatsapp";
      return (
        <RestoreRow key={key} threadId={r.thread.id} subject={r.message.subject} chat={chat}>
          {link}
        </RestoreRow>
      );
    }
    if (!props.deletable) return <Fragment key={key}>{link}</Fragment>;
    return (
      <TrashRow key={key} threadId={r.thread.id} subject={r.message.subject} handledLeaves={props.handledLeaves ?? false} hideable={folder === "messages" || folder === "inbox"} statusList={Boolean(params.status)} keepable={folder === "inbox"} wants={r.sort?.wants ?? null} senders={r.message.isFromOperator ? [] : [r.message.fromAddress]} ruled={r.message.isFromOperator ? null : ruleFor(r.message.fromAddress)} projects={folder === "inbox" ? projectsFor(r.account.id) : []} accountId={r.account.id} projectId={r.project?.id ?? null} unfiledLabel={UNFILED}>
        {link}
      </TrashRow>
    );
  };

  // Which numbers each row on screen is part of, read from the lists' own
  // conditions rather than restated here: there are eight rules about what
  // belongs in Reply / Action Required alone, and a second copy of them in
  // the browser would be wrong the first time one changed.
  const countRows = (() => {
    if (folder !== "inbox" && folder !== "messages") {
      // Sent and the rest keep what they had: the one row over this list.
      return params.status ? rows.map((r) => ({ threadId: r.thread.id, keys: [`${folder}:${params.status}`] })) : [];
    }
    const lists = listsOfMessages(core().db, folder, rows.map((r) => r.message.id), props.countScope ?? {});
    return rows.map((r) => ({ threadId: r.thread.id, keys: (lists.get(r.message.id) ?? []).map((l) => treeKeyForList(folder, l)) }));
  })();

  const groups = groupByThread(rows);
  const more = rows.length >= props.limit;

  return (
    <div className="inbox-panel">
      <ListKeys />
      <ListSeen listKey={listKey} />
      {/* The counts drop with the cards, not when the provider is done
          (2026-09-15), and every count a card was in rather than only the one
          over this list (operator, 2026-09-20: "really snappy"). */}
      {countRows.length > 0 ? <ListCount rows={countRows} handledLeaves={props.handledLeaves ?? false} /> : null}
      <div className="inbox-rows">
        {rows.length === 0 ? (
          <div className="inbox-empty">
            {/* A narrowed view that is empty is not an unsynced mailbox
                (stress audit, 2026-09-11: "No mail synced yet" over a
                project that simply held none of this folder). */}
            {params.project || params.fin || params.cat || params.status || params.inbox
              ? "Nothing here with these filters. Widen the period, or pick another project, in the header above."
              : activeWindow !== "all"
                ? "No mail in this window."
                : props.lastSyncAt
                  ? `Nothing in ${FOLDER_TITLES[folder]}.`
                  : "No mail synced yet."}
            {props.lastSyncAt ? <div className="meta">{`Last sync ${relativeTime(props.lastSyncAt)}`}</div> : null}
          </div>
        ) : (
          groups.map((group) => (
            <ThreadGroup
              key={group.threadId}
              defaultOpen={group.threadId === selectedThreadId}
              latest={row(group.latest)}
              older={group.older.map((r) => row(r))}
            />
          ))
        )}
        {more ? (
          <Link href={viewHref(props.pathname, { ...params, folder: undefined, rows: String(props.limit + LIST_PAGE) })} className="inbox-more">
            Show older
          </Link>
        ) : null}
      </div>
    </div>
  );
}
