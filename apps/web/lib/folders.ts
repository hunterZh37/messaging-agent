
/** The four mailboxes in the folder tree (spec 10a), and Messages, the texts on this Mac (2026-09-11). Matches core's `MailFolder`. */
export type FolderKey = "inbox" | "sent" | "trash" | "junk" | "messages";

/** The child rows: four under Inbox, two under Sent. */
// No need to reply was removed (operator, 2026-09-15: "remove no need to reply").
export type FolderStatus = "needs_reply" | "action" | "owed" | "knowing" | "disposable" | "unopened" | "waiting" | "not_waiting" | "hidden";

/** Where each folder lives. "Deleted items" reads better in a URL as `/deleted`. */
export const FOLDER_PATHS: Record<FolderKey, string> = {
  inbox: "/inbox",
  sent: "/sent",
  trash: "/deleted",
  junk: "/junk",
  messages: "/messages",
};

export const FOLDER_TITLES: Record<FolderKey, string> = {
  inbox: "Inbox",
  sent: "Sent",
  trash: "Deleted items",
  junk: "Junk & Spam",
  messages: "Messages",
};

export const STATUS_LABELS: Record<FolderStatus, string> = {
  // The ladder, in its own order (operator, 2026-09-19).
  needs_reply: "Reply",
  action: "Action Required",
  // The two of them under one row (operator, 2026-09-19).
  owed: "Reply / Action Required",
  knowing: "Worth Knowing",
  disposable: "Safe to Delete",
  unopened: "Unopened",
  waiting: "Waiting for reply",
  not_waiting: "Not waiting for reply",
  // The operator's own putting-away, which the ladder has no opinion about.
  hidden: "Archive",
};

/** Which statuses each folder has; Deleted items and Junk have none. */
const STATUSES: Record<FolderKey, FolderStatus[]> = {
  // Unopened sits above the ladder: it is what has not been looked at yet,
  // and it flows into one of the four rungs rather than being one of them.
  inbox: ["unopened", "owed", "needs_reply", "action", "knowing", "disposable", "hidden"],
  sent: ["waiting", "not_waiting"],
  trash: [],
  junk: [],
  messages: ["unopened", "needs_reply", "disposable", "hidden"],
};

/**
 * The child rows a folder offers in its own breadcrumb (operator, 2026-09-20:
 * "the word unopened should be clickable and a dropdown should appear").
 *
 * Not STATUSES: that list still carries `needs_reply` and `action` so links
 * made before the two shared a row keep working, and offering all three would
 * put the same mail behind three names.
 */
export const STATUS_MENU: Record<FolderKey, FolderStatus[]> = {
  inbox: ["unopened", "owed", "knowing", "disposable", "hidden"],
  sent: ["waiting", "not_waiting"],
  trash: [],
  junk: [],
  messages: ["unopened", "needs_reply", "disposable", "hidden"],
};

/** The `?status=` param, ignored when it names something this folder does not have. */
export function parseStatus(folder: FolderKey, param: string | undefined): FolderStatus | undefined {
  return STATUSES[folder].find((s) => s === param);
}

/** The `?folder=` param a thread link carries, defaulting to the inbox. */
export function parseFolder(param: string | undefined): FolderKey {
  return (Object.keys(FOLDER_PATHS) as FolderKey[]).find((f) => f === param) ?? "inbox";
}

/**
 * The path a thread opens at. Which folder it came from rides in the params
 * beside every other dimension rather than in the path, so the left pane
 * keeps showing the list the operator clicked out of.
 */
export function threadPath(threadId: string): string {
  return `/inbox/${encodeURIComponent(threadId)}`;
}

/** Everything a link carries: the whole state of the view, one param each. */
export interface ViewParams {
  /** An inbox named by the link itself, which outranks the remembered one for that visit. */
  account?: string;
  cat?: string;
  /** The Finance filter's side: `income` or `expense` (spec 7). */
  fin?: string;
  since?: string;
  status?: string;
  /** Which list the thread page shows beside the thread; meaningless elsewhere. */
  folder?: string;
  project?: string;
  /** Which editor is open under the header: `projects` or `1` for sub-categories. */
  edit?: string;
  /** How many messages the list reads, when the operator asked for more than the first page. */
  rows?: string;
  /**
   * The inbox whose pill is open under All inboxes (operator, 2026-09-11:
   * an open pill must narrow the list to that inbox, and its number must be
   * that inbox's mail). The switcher's inbox outranks it.
   */
  inbox?: string;
}

/**
 * Every link in the app (spec 10a, 10d). The header spans both panes on every
 * folder page and on a thread, so its links keep the page they are on rather
 * than sending the operator back to a folder: same pathname, and every param
 * of the view except the one being changed. Callers spread over the current
 * params, so `{ ...params, cat: undefined }` clears one. Building all of them
 * this way is what keeps the window, the money side, the project and the
 * inbox from being dropped by a click that meant to change one of them.
 */
export function viewHref(pathname: string, p: ViewParams = {}): string {
  const params = new URLSearchParams();
  const put = (key: string, value: string | undefined) => {
    if (value) params.set(key, value);
  };
  put("account", p.account);
  put("cat", p.cat);
  put("fin", p.fin);
  put("since", p.since);
  put("status", p.status);
  put("folder", p.folder);
  put("project", p.project);
  put("edit", p.edit);
  put("rows", p.rows);
  put("inbox", p.inbox);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** A glyph name the sidebar renders, or null for a child row (children carry no glyph). */
export type TreeIcon = "drafts" | "inbox" | "sent" | "deleted" | "junk" | "messages" | "hidden";

export interface TreeRow {
  /** Stable identity for the active row, and the React key. */
  key: string;
  label: string;
  href: string;
  icon: TreeIcon | null;
  /** True for the indented rows under Inbox and Sent. */
  child: boolean;
  /** Shown on the right, muted. */
  count: number;
  /**
   * Does this row count anything? A zero used to be hidden, which made an
   * empty Need to reply look like a row whose number had gone missing
   * (operator, 2026-09-18). Zero is an answer, so a counted row always shows
   * one. The folders above them count nothing and say nothing.
   */
  counted: boolean;
}

/**
 * The tree, top to bottom (spec 10a). Drafts is the approval queue at `/`;
 * the rest are folders. Children are always visible: the tree is short
 * enough that collapsing it would hide more than it saves. `p` is the view
 * the operator is in, which every row carries along.
 */
export function treeRows(
  counts: { inbox: number; drafts: number; needsReply: number; action: number; owed: number; knowing: number; unopened: number; disposable: number; waiting: number; hidden?: number; texts?: { needsReply: number; unopened: number; disposable: number; hidden?: number } },
  p: ViewParams = {},
): TreeRow[] {
  // A tree row changes the folder and the child row and nothing else: the
  // window, the money side, the project and the inbox come along, or clicking
  // "Need to reply" would quietly widen the mail underneath it.
  const carried: ViewParams = { ...p, folder: undefined, edit: undefined, status: undefined };
  const to = (folder: FolderKey, status?: FolderStatus) =>
    viewHref(FOLDER_PATHS[folder], { ...carried, ...(status ? { status } : {}) });
  return [
    // The approval queue has no folder and no filters, so it carries none.
    { key: "drafts", label: "Drafts", href: "/drafts", icon: "drafts", child: false, count: counts.drafts, counted: true },
    { key: "inbox", label: FOLDER_TITLES.inbox, href: to("inbox"), icon: "inbox", child: false, count: counts.inbox, counted: true },
    {
      key: "inbox:unopened",
      label: STATUS_LABELS.unopened,
      href: to("inbox", "unopened"),
      icon: null,
      child: true,
      count: counts.unopened,
      counted: true,
    },
    {
      key: "inbox:owed",
      label: STATUS_LABELS.owed,
      href: to("inbox", "owed"),
      icon: null,
      child: true,
      count: counts.owed,
      counted: true,
    },
    {
      key: "inbox:knowing",
      label: STATUS_LABELS.knowing,
      href: to("inbox", "knowing"),
      icon: null,
      child: true,
      count: counts.knowing,
      counted: true,
    },
    {
      key: "inbox:disposable",
      label: STATUS_LABELS.disposable,
      href: to("inbox", "disposable"),
      icon: null,
      child: true,
      count: counts.disposable,
      counted: true,
    },
    { key: "sent", label: FOLDER_TITLES.sent, href: to("sent"), icon: "sent", child: false, count: 0, counted: false },
    { key: "sent:waiting", label: STATUS_LABELS.waiting, href: to("sent", "waiting"), icon: null, child: true, count: counts.waiting, counted: true },
    { key: "sent:not_waiting", label: STATUS_LABELS.not_waiting, href: to("sent", "not_waiting"), icon: null, child: true, count: 0, counted: false },
    { key: "trash", label: FOLDER_TITLES.trash, href: to("trash"), icon: "deleted", child: false, count: 0, counted: false },
    // Hidden is a place, not a verdict, so it stands beside Deleted items
    // rather than under Inbox (operator, 2026-09-16).
    { key: "hidden", label: STATUS_LABELS.hidden, href: to("inbox", "hidden"), icon: "hidden", child: false, count: counts.hidden ?? 0, counted: true },
    { key: "junk", label: FOLDER_TITLES.junk, href: to("junk"), icon: "junk", child: false, count: 0, counted: false },
    // Texts (2026-09-11): their own folder, with the two rows that matter for a chat.
    ...(counts.texts
      ? [
          // "All chats": the toggle above already says Messages (2026-09-14).
          { key: "messages", label: "All chats", href: to("messages"), icon: "messages" as const, child: false, count: 0, counted: false },
          { key: "messages:needs_reply", label: STATUS_LABELS.needs_reply, href: to("messages", "needs_reply"), icon: null, child: true, count: counts.texts.needsReply, counted: true },
          { key: "messages:unopened", label: STATUS_LABELS.unopened, href: to("messages", "unopened"), icon: null, child: true, count: counts.texts.unopened, counted: true },
          { key: "messages:disposable", label: STATUS_LABELS.disposable, href: to("messages", "disposable"), icon: null, child: true, count: counts.texts.disposable, counted: true },
          { key: "messages:hidden", label: STATUS_LABELS.hidden, href: to("messages", "hidden"), icon: "hidden" as const, child: false, count: counts.texts.hidden ?? 0, counted: true },
        ]
      : []),
  ];
}

/**
 * The two sides of the app (operator, 2026-09-14: "a toggle where we can
 * switch between messages and emails, instead of having messages under the
 * left hand bar"). Mail is the four mailboxes and the drafts queue; Messages
 * is the chats from Messages and WhatsApp.
 */
export type TreeSide = "mail" | "messages";

/** The rows each side of the tree shows, by the tree row's key. */
export function rowsForSide(rows: TreeRow[], side: TreeSide): TreeRow[] {
  return rows.filter((r) => (side === "messages" ? r.key === "messages" || r.key.startsWith("messages:") : r.key !== "messages" && !r.key.startsWith("messages:")));
}

/**
 * Which side a page is on, or null when the page belongs to neither (the
 * Inboxes and Usage pages), where the side last chosen stays.
 */
export function sideOfPath(pathname: string, folderParam: string | undefined): TreeSide | null {
  if (pathname.startsWith("/inboxes") || pathname.startsWith("/accounts") || pathname.startsWith("/usage") || pathname.startsWith("/connecting")) return null;
  if (pathname === "/drafts") return "mail";
  const folder = folderOfPath(pathname, folderParam);
  if (folder === null) return null;
  return folder === "messages" ? "messages" : "mail";
}

/**
 * The list Messages opens on (operator, 2026-09-15): whatever is unopened,
 * since a chat nobody has read is the one that pulls; then what needs a
 * reply; and lastly all chats. Chats are not mail, and the operator reads
 * them the other way round, so this is not the Mail order.
 */
export function messagesLanding(counts: { needsReply: number; unopened: number } | undefined): FolderStatus | undefined {
  if (!counts) return undefined;
  if (counts.unopened > 0) return "unopened";
  if (counts.needsReply > 0) return "needs_reply";
  return undefined;
}

/**
 * Where each side of the toggle lands. Mail keeps the list the operator is on
 * (operator, 2026-09-15: switching "slaps on Need to reply"); a list Mail does
 * not have, Waiting for reply say, lands on the plain folder. Messages picks
 * its own by `messagesLanding` when the counts are to hand, since the list the
 * operator left on the mail side says nothing about the chats.
 */
export function sideHref(side: TreeSide, p: ViewParams = {}, texts?: { needsReply: number; unopened: number }): string {
  const folder: FolderKey = side === "messages" ? "messages" : "inbox";
  const carried: ViewParams = { since: p.since, status: parseStatus(folder, p.status) };
  if (side === "messages") return viewHref(FOLDER_PATHS.messages, { since: p.since, status: texts ? messagesLanding(texts) : carried.status });
  return viewHref(FOLDER_PATHS.inbox, { ...carried, account: p.account });
}

/** The folder a path shows, or null when the path is not a folder page. */
function folderOfPath(pathname: string, folderParam: string | undefined): FolderKey | null {
  if (pathname === "/sent" || pathname.startsWith("/sent/")) return "sent";
  if (pathname === "/deleted" || pathname.startsWith("/deleted/")) return "trash";
  if (pathname === "/junk" || pathname.startsWith("/junk/")) return "junk";
  if (pathname === "/messages" || pathname.startsWith("/messages/")) return "messages";
  // A thread opens at /inbox/<id> whichever folder it came from, so the link
  // that opened it says which row stays lit.
  if (pathname.startsWith("/inbox/")) return parseFolder(folderParam);
  if (pathname === "/inbox") return "inbox";
  return null;
}

/**
 * Does this page carry a content header (spec 10a, 10d)? The folder pages and
 * the thread do, and so does Drafts at `/`, whose header is the same family
 * with none of the filters. Each holds the refresh control for its own page,
 * so the top bar does not render a second one.
 */
export function hasProjectBar(pathname: string): boolean {
  return pathname === "/drafts" || folderOfPath(pathname, undefined) !== null;
}

/**
 * Which tree row is the one the operator is looking at. Returns `"inboxes"`
 * for the bottom link, and falls back to Drafts, which is what `/` shows.
 */
export function activeTreeKey(pathname: string, p: { folder?: string; status?: string } = {}): string {
  if (pathname.startsWith("/inboxes") || pathname.startsWith("/accounts")) return "inboxes";
  // The Usage page is its own row at the bottom; it is not the Drafts folder.
  if (pathname.startsWith("/usage")) return "usage";
  const folder = folderOfPath(pathname, p.folder);
  if (folder === null) return "drafts";
  const status = parseStatus(folder, p.status);
  // Hidden stands beside Deleted items rather than under Inbox, so the mail
  // side's row is keyed "hidden" and not "inbox:hidden" (2026-09-16).
  if (status === "hidden" && folder === "inbox") return "hidden";
  return status ? `${folder}:${status}` : folder;
}

/** Messages a list reads before "Show older" (operator, 2026-09-11: All time used to stop silently at the newest hundred). */
export const LIST_PAGE = 100;

/** How many messages the list reads: the `?rows=` param, or one page. */
export function listLimit(param: string | undefined): number {
  const n = Number(param);
  return Number.isInteger(n) && n > 0 ? n : LIST_PAGE;
}
