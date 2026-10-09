import type { Notice } from "@messaging-agent/core";

/**
 * Telling the phone an inbox has stopped letting Celeste in (operator,
 * 2026-10-09: "set up Celeste so that everything will be automated and
 * authenticated").
 *
 * Two of their inboxes once sat locked out for two and a half days, and the
 * only sign of it was a panel they had to open Celeste to see — so nothing
 * arrived from those mailboxes and nothing said so. A mailbox that has quietly
 * stopped is the one failure here that hides as silence, and the phone is
 * where they would notice it.
 *
 * The mail clock runs every two minutes, so the whole problem is saying it
 * once rather than seven hundred times a day. These two functions are the
 * saying-it-once; `push.ts` does the sending.
 */

/**
 * Which of the inboxes now locked out have not been announced yet, and — as a
 * side effect, because the caller's set *is* the memory — forgetting the ones
 * that have come back. Forgetting matters twice over: the set cannot grow
 * without bound, and an inbox that is fixed and then breaks again next month
 * is news again rather than something already said.
 */
export function newlyDown(alreadySaid: Set<string>, downNow: string[]): string[] {
  const down = new Set(downNow);
  for (const email of [...alreadySaid]) {
    if (!down.has(email)) alreadySaid.delete(email);
  }
  const fresh = downNow.filter((email) => !alreadySaid.has(email));
  for (const email of fresh) alreadySaid.add(email);
  return fresh;
}

/**
 * What the phone shows. One tag for all of them, so a second inbox going down
 * replaces the notification rather than stacking beside it: the operator wants
 * to know the state of their mail, not to collect one card per failure.
 *
 * It names the inboxes rather than saying "some inboxes", because which one
 * decides whether they deal with it now or tonight.
 */
export function signinNotice(emails: string[]): Notice {
  const many = emails.length > 1;
  return {
    title: many ? `${emails.length} inboxes need you to sign in` : "An inbox needs you to sign in",
    body: many ? `Nothing is arriving from ${emails.join(", ")}.` : `Nothing is arriving from ${emails[0]}.`,
    url: "/inboxes",
    tag: "celeste-signin",
  };
}
