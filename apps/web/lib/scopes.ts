import { FOLDER_PATHS, parseFolder, parseStatus, type FolderKey, type FolderStatus } from "./folders";
import { selectedWindow, type FinanceKey, type WindowKey } from "./selection";

/** What the header knows about the view, before either count narrows it. */
export interface ViewScope {
  folder: FolderKey;
  accountId?: string;
  status?: FolderStatus;
  /** The window's start in epoch ms; null for "All", which has no lower bound. */
  since: number | null;
  project?: string;
  finance?: FinanceKey;
}

/** A scope as core's counts take it. */
export interface CountScope {
  folder: FolderKey;
  accountId?: string;
  status?: FolderStatus;
  since?: number;
  projectId?: string;
  finance?: FinanceKey;
}

/**
 * The order the header's axes stand in (spec 10a; operator, 2026-09-09:
 * "The order should always be: 1. Project 2. We can either choose window or
 * finance. You cannot dictate the project by choosing finance").
 *
 * A project is what the mail is about, so its tabs are counted over the
 * folder, the tree's child row and the inbox, and the money side never moves
 * them. The window does narrow the numbers (operator, 2026-09-15: the bar
 * said 12 over a Today list that was empty), but never which tabs show:
 * callers decide that from a second count taken with `since: null`, so the
 * row keeps its shape on a quiet day.
 */
export function projectCountScope(view: ViewScope): CountScope {
  return {
    folder: view.folder,
    ...(view.accountId ? { accountId: view.accountId } : {}),
    ...(view.status ? { status: view.status } : {}),
    ...(view.since !== null && view.since !== undefined ? { since: view.since } : {}),
  };
}

/**
 * Finance sits below the project and beside the window, so its counts take
 * everything: the project that is on narrows them, and so does the window.
 * Each side's number is what clicking it would show.
 */
export function financeCountScope(view: ViewScope): CountScope {
  return {
    folder: view.folder,
    ...(view.accountId ? { accountId: view.accountId } : {}),
    ...(view.status ? { status: view.status } : {}),
    ...(view.since === null ? {} : { since: view.since }),
    ...(view.project ? { projectId: view.project } : {}),
  };
}

/**
 * The view a link leads to, read back off the link itself. An action that
 * redirects somewhere has to judge what the operator will be looking at when
 * they land, and the href it was handed is exactly that; asking the caller to
 * describe it a second time is how the two come to disagree.
 */
export function viewFromHref(href: string, windowCookie?: string): { folder: FolderKey; status?: FolderStatus; window: WindowKey } {
  const [pathname = "/", query] = href.split("?");
  const params = new URLSearchParams(query ?? "");
  // A thread keeps its own path, and says in a param which list is beside it.
  const named = (Object.keys(FOLDER_PATHS) as FolderKey[]).find((f) => FOLDER_PATHS[f] === pathname);
  const folder = named ?? parseFolder(params.get("folder") ?? undefined);
  const status = parseStatus(folder, params.get("status") ?? undefined);
  return {
    folder,
    ...(status ? { status } : {}),
    window: selectedWindow(params.get("since") ?? undefined, windowCookie),
  };
}
