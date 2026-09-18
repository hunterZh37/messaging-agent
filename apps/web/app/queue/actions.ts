"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { countByFinance } from "@messaging-agent/core";
import { core } from "@/lib/core";
import { windowStart } from "@/app/inbox/shared";
import { financeCountScope, viewFromHref } from "@/lib/scopes";
import {
  ACCOUNT_COOKIE,
  ACCOUNT_COOKIE_MAX_AGE,
  FINANCE_COOKIE,
  PROJECT_COOKIE,
  projectCookieValue,
  projectScope,
  selectedFinance,
  WINDOW_COOKIE,
} from "@/lib/selection";

/** Keeps the redirect on this app: only a path of our own, never an absolute URL. */
function samePathOnly(target: string): string {
  return target.startsWith("/") && !target.startsWith("//") ? target : "/";
}

/**
 * The inbox switcher's choice: `id` for one inbox, `null` for All. Remembered
 * per browser (spec 10a), then back to the page the operator is on — without
 * `?account=`, so the cookie is what the next click reads, and with the
 * filter, window, and sub-category the caller passes through in `target`.
 */
export async function selectAccountAction(id: string | null, target: string): Promise<void> {
  const jar = await cookies();
  if (id) {
    jar.set(ACCOUNT_COOKIE, id, { httpOnly: false, sameSite: "lax", path: "/", maxAge: ACCOUNT_COOKIE_MAX_AGE });
  } else {
    jar.delete(ACCOUNT_COOKIE);
  }
  redirect(samePathOnly(target));
}

/**
 * The project bar's choice: a project id or `"unfiled"` for one inbox, an
 * inbox's `"unfiled:<id>"` under All inboxes, `null` for All projects.
 * Remembered per inbox (spec 10d) — and under its own owner when the choice
 * was made under All inboxes, where `accountId` is absent and the switcher
 * has to stay on All — so it survives a move between folders, then back to
 * the page the operator is on without `?project=`, since the cookie is what
 * the next click reads.
 */
export async function selectProjectAction(accountId: string | undefined, project: string | null, target: string): Promise<void> {
  const jar = await cookies();
  remember(jar, PROJECT_COOKIE, project ? projectCookieValue(accountId, project) : null);
  // A money side belongs to the project it was picked in. If the one being
  // opened holds none of it, the side comes off with the move rather than
  // greeting the operator as an empty list they did not ask for.
  const finance = selectedFinance(undefined, jar.get(FINANCE_COOKIE)?.value);
  if (finance) {
    const { db } = core();
    const view = viewFromHref(target, jar.get(WINDOW_COOKIE)?.value);
    // The choice may name the inbox itself, which is how an inbox's Unfiled
    // narrows to that inbox under All: the money counts follow the same split.
    const scope = projectScope(project ?? undefined);
    const scoped = accountId ?? scope.accountId;
    const counts = countByFinance(
      db,
      financeCountScope({
        folder: view.folder,
        ...(scoped ? { accountId: scoped } : {}),
        ...(view.status ? { status: view.status } : {}),
        since: windowStart(view.window),
        ...(scope.projectId ? { project: scope.projectId } : {}),
      }),
    );
    if (counts[finance] === 0) remember(jar, FINANCE_COOKIE, null);
  }
  redirect(samePathOnly(target));
}

/** One cookie, one year, readable by the client: the same terms every remembered choice takes. */
function remember(jar: Awaited<ReturnType<typeof cookies>>, name: string, value: string | null, forVisit = false): void {
  if (!value) jar.delete(name);
  else jar.set(name, value, { httpOnly: false, sameSite: "lax", path: "/", ...(forVisit ? {} : { maxAge: ACCOUNT_COOKIE_MAX_AGE }) });
}

/**
 * The window chip's choice, remembered so it survives a move to another
 * folder or a thread (spec 5), then back to the page the operator is on
 * without `?since=`, since the cookie is what the next click reads. A
 * session cookie: the next open of Celeste starts on Today again.
 */
export async function selectWindowAction(window: string, target: string): Promise<void> {
  remember(await cookies(), WINDOW_COOKIE, window, true);
  redirect(samePathOnly(target));
}

/** The Finance chip's choice: one side of the money axis, or `null` for both (spec 7). */
export async function selectFinanceAction(finance: string | null, target: string): Promise<void> {
  remember(await cookies(), FINANCE_COOKIE, finance);
  redirect(samePathOnly(target));
}
