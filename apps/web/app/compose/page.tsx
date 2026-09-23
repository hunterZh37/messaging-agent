import { schema } from "@messaging-agent/core";
import { core } from "@/lib/core";
import { Nav } from "../queue/Sidebar";
import { treeCounts } from "../queue/counts";
import { resolveForTree, treeScope, viewSelection } from "../inbox/selection";
import { inboxSwitcher } from "../queue/switcher";
import { ThemeToggle } from "../queue/ThemeToggle";
import { AddInbox } from "../inboxes/AddInbox";
import { ComposeForm } from "./ComposeForm";

export const dynamic = "force-dynamic";

/**
 * The composer (spec 2026-09-22): a message that begins a conversation
 * rather than answering one, reachable from the Compose button above the
 * folder tree. Mail only for now — iMessage and WhatsApp compose land in
 * their own change, each with the operator's standing rule against driving
 * those apps to test.
 */
export default async function ComposePage() {
  const { db, cfg } = core();
  const { selectedId } = await inboxSwitcher(undefined);

  // Messages on this Mac and WhatsApp have no compose yet (spec 2026-09-22):
  // only an account that can send mail belongs in this picker.
  const accounts = db
    .select()
    .from(schema.accounts)
    .all()
    .filter((a) => a.provider !== "imessage" && a.provider !== "whatsapp")
    .map((a) => ({ id: a.id, email: a.email, displayName: a.displayName }));

  return (
    <main>
      <div className="page-header-row">
        <h1>Compose</h1>
        <ThemeToggle className="btn quiet icon-only theme-toggle-mobile" />
      </div>

      {accounts.length === 0 ? (
        <div className="empty-wrap">
          <div className="empty-title">Add an inbox to compose from</div>
          <AddInbox microsoftReady={Boolean(cfg.microsoft.clientId)} defaultOpen />
        </div>
      ) : (
        <ComposeForm accounts={accounts} />
      )}

      <Nav counts={treeCounts(selectedId, treeScope(resolveForTree(db, selectedId, await viewSelection(db, selectedId))))} />
    </main>
  );
}
