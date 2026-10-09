import type { Notice } from "@messaging-agent/core";

/**
 * Telling the phone an inbox has stopped letting Celeste in (operator,
 * 2026-10-09: "set up Celeste so that everything will be automated and
 * authenticated").
 *
 * Two of their inboxes once sat locked out for two and a half days. Nothing
 * arrived from either and nothing said so, because the only sign was a panel
 * they had to open Celeste to see. A mailbox that has quietly stopped is the
 * one failure here that hides as silence, and the phone is where they would
 * notice it.
 *
 * Two things have to be true at once. The mail clock ticks every two minutes,
 * so an inbox that stays broken must buzz once rather than seven hundred times
 * a day. And a notice that was never delivered must not count as said — the
 * first version of this marked an inbox announced before the send was even
 * awaited, so a push service answering 500 swallowed the notice for the whole
 * outage (review, 2026-10-09). A thing built to end silent failure failing
 * silently is the worst of the shapes this could take.
 */

/** How the notice reaches a phone. Injected so the retry above can be tested without one. */
export type SendNotice = (notice: Notice) => Promise<{ sent: number; gone: number }>;

/**
 * What has changed since the last tick: which locked-out inboxes have not been
 * announced, and which have come back. Decides only — it changes nothing it is
 * given, so the caller can hold the announcement back until a phone has
 * actually been told.
 */
export function signinChanges(alreadySaid: Set<string>, downNow: string[]): { fresh: string[]; recovered: string[] } {
  const down = new Set(downNow);
  return {
    fresh: downNow.filter((email) => !alreadySaid.has(email)),
    recovered: [...alreadySaid].filter((email) => !down.has(email)),
  };
}

/**
 * One tick's worth of telling them. Forgetting a recovered inbox happens
 * whatever else does — it costs nothing and it is what makes the same inbox
 * breaking again next month news again. Announcing is only remembered when the
 * send reports that something received it; until then every tick tries again,
 * which is also what gets a notice to a phone that subscribes *after* the
 * inbox went down.
 */
export async function announceSignin(
  alreadySaid: Set<string>,
  downNow: string[],
  send: SendNotice,
): Promise<{ announced: string[]; delivered: boolean }> {
  const { fresh, recovered } = signinChanges(alreadySaid, downNow);
  for (const email of recovered) alreadySaid.delete(email);
  if (fresh.length === 0) return { announced: [], delivered: false };

  // Every inbox that is down, not only the newly broken one: what they want to
  // know is the state of their mail, not which failure happened most recently.
  const { sent } = await send(signinNotice(downNow));
  if (sent > 0) for (const email of fresh) alreadySaid.add(email);
  return { announced: fresh, delivered: sent > 0 };
}

/**
 * What the phone shows. One tag for all of them, so a second inbox going down
 * replaces the notification rather than stacking beside it, and it names the
 * inboxes because which one decides whether they deal with it now or tonight.
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
