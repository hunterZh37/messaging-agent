import { notFound } from "next/navigation";
import { listPersonThreads, personFor } from "@messaging-agent/core";
import { core } from "@/lib/core";
import { listLimit, viewHref, type ViewParams } from "@/lib/folders";
import { Nav } from "../../queue/Sidebar";
import { treeCounts } from "../../queue/counts";
import { inboxSwitcher } from "../../queue/switcher";
import { resolveForTree, treeScope, viewSelection } from "../../inbox/selection";
import { sidebarPeople } from "../../queue/people";
import { InboxList } from "../../inbox/InboxList";
import { ListScroll } from "../../inbox/ListScroll";

export const dynamic = "force-dynamic";

/**
 * One person's own page (operator, 2026-09-28: "there should be a feature
 * where I can easily access to the most common thread with contacts I talk
 * to a lot"): every conversation with them, mail and texts together, in one
 * list. No content header here — a person has no folder, no project and no
 * window to narrow by, so the header would be all filters this page has no
 * use for; the name, their handles and a plain count say what the folder
 * pages need a whole bar to say.
 */
export default async function PersonPage({
  params,
  searchParams,
}: {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ rows?: string }>;
}) {
  const { handle: rawHandle } = await params;
  const { rows: rowsParam } = await searchParams;
  const { db } = core();
  const person = personFor(db, decodeURIComponent(rawHandle));
  if (!person) notFound();

  const { selectedId } = await inboxSwitcher(undefined);
  const limit = listLimit(rowsParam);
  const rows = listPersonThreads(db, person.handles, { limit });
  const pathname = `/people/${encodeURIComponent(person.key)}`;
  // Rows here span whatever folder each thread's last message actually sits
  // in (mail, texts, sent mail among them); "inbox" is the closest single
  // folder to pass a list built that way, which chat rows tell apart on
  // their own account's provider, whatever this says (see InboxList/Row).
  const params_: ViewParams = { ...(rowsParam ? { rows: rowsParam } : {}) };

  return (
    <main className="inbox-page">
      <header className="content-head person-head">
        <div className="head-row first">
          <span className="head-title">{person.name ?? person.key}</span>
          <span className="head-sub">{person.handles.join(", ")}</span>
          <div className="head-spacer" />
          <span className="head-hint">{rows.length === 1 ? "1 conversation" : `${rows.length} conversations`}</span>
        </div>
      </header>
      <div className="inbox-grid">
        <ListScroll scrollKey={viewHref(pathname, { ...params_, rows: undefined })} className="inbox-list">
          <InboxList
            rows={rows}
            folder="inbox"
            params={params_}
            window="all"
            lastSyncAt={null}
            deletable={false}
            restorable={false}
            pathname={pathname}
            limit={limit}
          />
        </ListScroll>
        <div className="inbox-detail placeholder">
          <span>Select a message.</span>
        </div>
      </div>
      {/* The tree's numbers are the operator's own selection wherever they
          are read, not this page's: an unscoped count said Inbox 1724 here
          and Inbox 17 a click away (2026-09-28). Every page that is not a
          folder counts this same way. */}
      <Nav counts={treeCounts(selectedId, treeScope(resolveForTree(db, selectedId, await viewSelection(db, selectedId))))} people={sidebarPeople()} />
    </main>
  );
}
