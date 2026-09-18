import { cookies } from "next/headers";
import { schema } from "@messaging-agent/core";
import { core } from "@/lib/core";
import { landingHref, landingPage } from "@/lib/landing";
import { ACCOUNT_COOKIE, selectedAccountId } from "@/lib/selection";
import { treeCounts } from "./queue/counts";
import { resolveForTree, treeScope, viewSelection } from "./inbox/selection";

export const dynamic = "force-dynamic";

/**
 * Celeste opens on Need to reply, then Unopened, then the Inbox (operator,
 * 2026-09-15), counted over what the tree shows there: the switcher's inbox,
 * the remembered project and money side, and the tab's window. A page rather
 * than a redirect, so it can mark the tab as opened on the way.
 */
export async function GET(): Promise<Response> {
  const { db } = core();
  const accounts = db.select().from(schema.accounts).all().filter((a) => a.provider !== "imessage" && a.provider !== "whatsapp");
  let href = "/inbox";
  if (accounts.length > 0) {
    const selectedId = selectedAccountId(undefined, (await cookies()).get(ACCOUNT_COOKIE)?.value, accounts);
    const view = resolveForTree(db, selectedId, await viewSelection(db, selectedId));
    href = landingHref(treeCounts(selectedId, treeScope(view)));
  }
  return new Response(landingPage(href), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
