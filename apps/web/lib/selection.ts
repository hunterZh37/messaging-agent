import { shortAccount } from "./format";

/** Where the inbox switcher's choice is remembered. Nothing secret, so no httpOnly. */
export const ACCOUNT_COOKIE = "celeste-account";

/** Where Ask Celeste's panel remembers being open (spec 10c). `1`, or absent. */
export const ASK_COOKIE = "celeste-ask";

/** A year: the choice should outlive any single session. */
export const ACCOUNT_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export interface SelectableAccount {
  id: string;
  email: string;
  status: "ok" | "needs_signin" | "disconnected";
}

/**
 * Which inbox every surface shows (spec 10a). A link naming an inbox wins for
 * that visit; otherwise the remembered choice in the `celeste-account` cookie;
 * otherwise All. An id that names nothing connected is ignored rather than
 * emptying the app, so a disconnected or deleted inbox falls back to All.
 */
export function selectedAccountId(
  searchParam: string | undefined,
  cookieValue: string | undefined,
  accounts: SelectableAccount[],
): string | undefined {
  const connected = (id: string | undefined) =>
    id ? accounts.some((a) => a.id === id && a.status !== "disconnected") : false;
  if (connected(searchParam)) return searchParam;
  if (connected(cookieValue)) return cookieValue;
  return undefined;
}

/** Where the project bar's choice is remembered, per inbox. Nothing secret either. */
export const PROJECT_COOKIE = "celeste-project";

/**
 * What a message no project claims reads as, on a URL and in the cookie.
 * Matches core's `UNFILED_KEY`; spelled out here so this stays a pure module
 * with no database import behind it.
 */
export const UNFILED_PROJECT = "unfiled";

/**
 * What owns a project choice made under All inboxes. A project belongs to one
 * inbox, but the choice does not: the bar there shows every inbox's projects
 * at once (spec 10d), so the choice is remembered under its own name rather
 * than under an inbox that would then leak it into that inbox's own view.
 * No account id can collide with it, since account ids are uuids.
 */
export const ALL_INBOXES_OWNER = "all";

/**
 * What one inbox's Unfiled tab is called under All inboxes. Every project id
 * names one inbox by itself, so picking a project narrows the list to that
 * inbox's mail on its own; "unfiled" does not, and two inboxes' Unfiled tabs
 * would both open the same list across both of them while showing different
 * numbers. Naming the inbox in the value is what keeps each row's count equal
 * to the list it opens.
 */
export function unfiledInInbox(accountId: string): string {
  return `${UNFILED_PROJECT}:${accountId}`;
}

/**
 * Which project the folder views filter by (spec 10d). A link naming one of
 * the projects on the bar wins for that visit; otherwise the
 * `celeste-project` cookie, which carries the inbox it was set for so one
 * inbox's choice never leaks into another; otherwise All projects. A project
 * the operator has since deleted names nothing, so it is ignored rather than
 * emptying the list. Under All inboxes the bar holds every inbox's projects,
 * so any of them may be picked; the choice is remembered under
 * `ALL_INBOXES_OWNER`, and Unfiled has to name the inbox it belongs to.
 */
export function selectedProject(
  searchParam: string | undefined,
  cookieValue: string | undefined,
  accountId: string | undefined,
  projects: { id: string }[],
  inboxes: string[] = [],
): string | undefined {
  const owner = accountId ?? ALL_INBOXES_OWNER;
  const known = (v: string | undefined) => {
    if (v === undefined || v === "") return false;
    // Under one inbox, Unfiled is that inbox's; under All it has to say which.
    if (v === UNFILED_PROJECT) return accountId !== undefined;
    if (!accountId && v.startsWith(`${UNFILED_PROJECT}:`)) return inboxes.includes(v.slice(UNFILED_PROJECT.length + 1));
    return projects.some((p) => p.id === v);
  };
  if (known(searchParam)) return searchParam;
  const at = cookieValue?.indexOf(":") ?? -1;
  if (at === -1) return undefined;
  const cookieOwner = cookieValue!.slice(0, at);
  const project = cookieValue!.slice(at + 1);
  if (cookieOwner !== owner) return undefined;
  return known(project) ? project : undefined;
}

/** The cookie the project bar writes: the choice, and the inbox it belongs to. */
export function projectCookieValue(accountId: string | undefined, project: string): string {
  return `${accountId ?? ALL_INBOXES_OWNER}:${project}`;
}

/**
 * The choice as the list and every count take it: the project to filter by,
 * and the inbox it names, if it names one. Everything that describes the view
 * has to read it through here, or one of them ends up counting an inbox's
 * Unfiled while another lists every inbox's.
 */
export function projectScope(project: string | undefined): { projectId?: string; accountId?: string } {
  if (!project) return {};
  const prefix = `${UNFILED_PROJECT}:`;
  if (project.startsWith(prefix)) return { projectId: UNFILED_PROJECT, accountId: project.slice(prefix.length) };
  return { projectId: project };
}

/**
 * Where the window chip's choice is remembered: for the visit only, so every
 * open starts on Today (operator, 2026-09-15). A new name, because the old
 * cookie held a year-long choice that would otherwise still win.
 */
export const WINDOW_COOKIE = "celeste-window-visit";

/** Where the Finance chip's choice is remembered. */
export const FINANCE_COOKIE = "celeste-finance";

/** The window a visit starts on, and what clearing the window goes back to (operator, 2026-09-15). */
export const DEFAULT_WINDOW = "today" satisfies WindowKey;

/** The windows the chips offer, in the order they sit in (spec 5). */
export const WINDOWS = ["today", "7d", "30d", "all"] as const;
export type WindowKey = (typeof WINDOWS)[number];

/** The window every surface reaches back over: the link's, then the one picked this visit, then Today. */
export function selectedWindow(searchParam: string | undefined, cookieValue: string | undefined): WindowKey {
  const known = (v: string | undefined): v is WindowKey => WINDOWS.includes(v as WindowKey);
  if (known(searchParam)) return searchParam;
  if (known(cookieValue)) return cookieValue;
  return DEFAULT_WINDOW;
}

/** The two sides of the money axis (spec 7); undefined means both. */
export type FinanceKey = "income" | "expense";

/** Which side of the money axis is on: the link's, then the remembered one, then neither. */
export function selectedFinance(searchParam: string | undefined, cookieValue: string | undefined): FinanceKey | undefined {
  const known = (v: string | undefined): v is FinanceKey => v === "income" || v === "expense";
  if (known(searchParam)) return searchParam;
  if (known(cookieValue)) return cookieValue;
  return undefined;
}

/**
 * A money side only means something inside the project and window it is read
 * in (spec 10a). When the level above changes and the side that was applied
 * holds nothing under the new one, it is dropped rather than left on: keeping
 * it would show an empty list and a filter the operator did not choose for
 * this project. The counts here are taken without the side applied, so this
 * asks "is there any of it here", not "is the list empty".
 */
export function financeWithMail(
  finance: FinanceKey | undefined,
  counts: { income: number; expense: number },
): FinanceKey | undefined {
  if (!finance) return undefined;
  return counts[finance] > 0 ? finance : undefined;
}

/**
 * Switcher labels by account id: the domain, or the full address when two
 * inboxes share a domain and the domain alone would not say which is which.
 */
export function accountLabels(accounts: { id: string; email: string }[]): Record<string, string> {
  const seen = new Map<string, number>();
  for (const a of accounts) {
    const domain = shortAccount(a.email);
    seen.set(domain, (seen.get(domain) ?? 0) + 1);
  }
  const out: Record<string, string> = {};
  for (const a of accounts) {
    const domain = shortAccount(a.email);
    out[a.id] = (seen.get(domain) ?? 0) > 1 ? a.email : domain;
  }
  return out;
}
