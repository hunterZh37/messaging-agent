import { diagramFile } from "@/lib/diagram";
import { core } from "@/lib/core";
import { Nav } from "../queue/Sidebar";
import { treeCounts } from "../queue/counts";
import { inboxSwitcher } from "../queue/switcher";
import { ThemeToggle } from "../queue/ThemeToggle";

export const dynamic = "force-dynamic";

/**
 * The system diagram, inside the app (operator, 2026-09-22: "this diagram to
 * be accessible from Celeste UI/UX. Create a button. When I click on it I can
 * see it").
 *
 * The diagram is an archify page with its own theme, guided views, Present and
 * Export, so it is shown in a frame rather than pulled apart and rebuilt here:
 * a rebuild would be a second copy to keep true, which is the failure the
 * drift gate exists to prevent. The frame loads /api/architecture, which reads
 * the rendered file from disk on every request.
 */
export default async function ArchitecturePage({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const { account } = await searchParams;
  core();
  const { selectedId } = await inboxSwitcher(account);
  const rendered = diagramFile() !== null;

  return (
    <div className="shell">
      <Nav counts={treeCounts(selectedId)} />
      <main className="architecture-page">
        <div className="head-row first">
          <span className="head-title">Architecture</span>
          <span className="head-sub">how Celeste is put together</span>
          <span className="head-spacer" />
          <ThemeToggle />
        </div>
        {rendered ? (
          <iframe className="architecture-frame" src="/api/architecture" title="Celeste system architecture" />
        ) : (
          <p className="architecture-missing">
            The diagram has not been rendered yet. Run <code>pnpm diagram</code>, or render it with archify, and reload
            this page.
          </p>
        )}
      </main>
    </div>
  );
}
