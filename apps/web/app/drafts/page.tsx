import { listPendingDrafts, schema } from "@messaging-agent/core";
import { core } from "@/lib/core";
import { Queue } from "../queue/Queue";
import { Nav } from "../queue/Sidebar";
import { treeCounts } from "../queue/counts";
import { AddInbox } from "../inboxes/AddInbox";
import { resolveForTree, treeScope, viewSelection } from "../inbox/selection";
import { inboxSwitcher } from "../queue/switcher";

export const dynamic = "force-dynamic";

/**
 * The Drafts folder at `/` (spec 8, 10a): the same two panes as every other
 * folder, the pending drafts on the left and the card for the open one on the
 * right. `?draft=` names the open one, which is where the thread page's "Open
 * in queue" points and where Skip and Send move the operator next.
 */
export default async function QueuePage({ searchParams }: { searchParams: Promise<{ draft?: string; account?: string }> }) {
  const { draft, account } = await searchParams;
  const { db, cfg } = core();
  const { selectedId, switcher } = await inboxSwitcher(account);
  const accountCount = db.select().from(schema.accounts).all().length;

  if (accountCount === 0) {
    return (
      <main>
        <div className="empty-wrap">
          <div className="empty-title">Add your first inbox</div>
          <AddInbox microsoftReady={Boolean(cfg.microsoft.clientId)} defaultOpen />
        </div>
        {/* No accounts yet: no window either, so the tree opens on its default. */}
        <Nav counts={treeCounts(selectedId)} />
      </main>
    );
  }

  // Queue order, oldest first: the operator works down the list, and nothing
  // reorders it under their hand. `?draft=` decides what is open, not where.
  const items = listPendingDrafts(db, { accountId: selectedId });
  return (
    <main className="inbox-page">
      <Queue items={items} selected={draft} account={account} switcher={switcher} />
      <Nav counts={treeCounts(selectedId, treeScope(resolveForTree(db, selectedId, await viewSelection(db, selectedId))))} />
    </main>
  );
}
