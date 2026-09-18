import { folderCounts } from "@messaging-agent/core";
import { core } from "@/lib/core";
import type { TreeScope } from "@/app/inbox/selection";
import type { TreeCounts } from "./Sidebar";
import { imessageAccount, whatsappAccount } from "@messaging-agent/core";

/**
 * The folder tree's three counts for the inbox the switcher has picked, or
 * for all of them, over the selection the operator has on: the window, the
 * project and the money side. A tree row's number is the length of the list
 * that row opens, which is the whole point of showing it there.
 */
export function treeCounts(accountId: string | undefined, scope: TreeScope = {}): TreeCounts {
  const { db } = core();
  const counts = folderCounts(db, { ...scope, ...(accountId ? { accountId } : {}) });
  // The Messages rows appear once Messages on this Mac is connected (2026-09-11).
  return imessageAccount(db) || whatsappAccount(db) ? counts : { ...counts, texts: undefined };
}
