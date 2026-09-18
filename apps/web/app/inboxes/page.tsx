import Link from "next/link";
import { eq, sql } from "drizzle-orm";
import { backlogSorterIsTrickle, formatModelRef, MODEL_ENV_VARS, MODEL_ROLES, schema } from "@messaging-agent/core";
import { core } from "@/lib/core";
import { Nav } from "../queue/Sidebar";
import { treeCounts } from "../queue/counts";
import { resolveForTree, treeScope, viewSelection } from "../inbox/selection";
import { inboxSwitcher } from "../queue/switcher";
import { ThemeToggle } from "../queue/ThemeToggle";
import { AddInbox } from "./AddInbox";
import { ConnectMessages } from "./ConnectMessages";
import { ConnectWhatsapp } from "./ConnectWhatsapp";
import { relativeTime } from "@/lib/format";
import { AlsoYou } from "./AlsoYou";
import { DisconnectButton } from "./DisconnectButton";
import { aliasesForForm } from "./aliases";

export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  missing_microsoft_client_id: "MICROSOFT_CLIENT_ID is not set in .env.",
  missing_google_client_id: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set in .env.",
  state_mismatch: "Sign-in could not be verified. Try again.",
};

function MailGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" style={{ width: 14, height: 14, stroke: "currentColor", fill: "none", strokeWidth: 1.75 }}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </svg>
  );
}

/** What each role is called where the operator can see it. */
const ROLE_LABELS: Record<(typeof MODEL_ROLES)[number], string> = {
  sorter: "Sorting",
  sorter_backlog: "Sorting a backlog",
  drafter: "Drafting",
  chat: "Ask Celeste",
  stats: "Reading your tone",
};

function kindLabel(a: { provider: "imap" | "outlook" | "imessage" | "whatsapp"; kind: "gmail" | "generic" | null }): string {
  if (a.provider === "outlook") return "Outlook";
  if (a.provider === "imessage") return "Messages on this Mac";
  if (a.provider === "whatsapp") return "WhatsApp on this Mac";
  return a.kind === "gmail" ? "Gmail" : "IMAP";
}

export default async function InboxesPage({ searchParams }: { searchParams: Promise<{ error?: string; account?: string }> }) {
  const { error, account } = await searchParams;
  const { db, cfg } = core();
  const { selectedId, switcher } = await inboxSwitcher(account);

  const microsoftReady = Boolean(cfg.microsoft.clientId);
  const googleReady = Boolean(cfg.google.clientId && cfg.google.clientSecret);
  // Which IMAP inboxes sign in with Google rather than a password (2026-09-11): their Reconnect goes through Google.
  const withGoogle = new Set(db.select({ id: schema.oauthTokens.accountId }).from(schema.oauthTokens).all().map((r) => r.id));
  const withPassword = new Set(db.select({ id: schema.mailCredentials.accountId }).from(schema.mailCredentials).all().map((r) => r.id));

  const accountRows = db.select().from(schema.accounts).all();
  const lastSyncByAccount = new Map(db.select().from(schema.watermarks).all().map((w) => [w.accountId, w.lastSyncAt]));
  const pendingCounts = db
    .select({ accountId: schema.messages.accountId, count: sql<number>`count(*)` })
    .from(schema.drafts)
    .innerJoin(schema.messages, eq(schema.messages.id, schema.drafts.replyToMessageId))
    .where(eq(schema.drafts.status, "pending"))
    .groupBy(schema.messages.accountId)
    .all();
  const pendingByAccount = new Map(pendingCounts.map((p) => [p.accountId, p.count]));

  return (
    <main>
      <div className="page-header-row">
        <h1>Inboxes</h1>
        <div className="row" style={{ marginTop: 0 }}>
          {/* The one thing to do on this page, where the eye lands first
              (desktop audit, 2026-09-11: it sat below the fold). */}
          <AddInbox microsoftReady={microsoftReady} googleReady={googleReady} />
          <ConnectMessages connected={accountRows.some((a) => a.provider === "imessage")} />
          <ConnectWhatsapp connected={accountRows.some((a) => a.provider === "whatsapp")} />
          <ThemeToggle className="btn quiet icon-only theme-toggle-mobile" />
        </div>
      </div>

      {error ? <div className="error">{ERROR_MESSAGES[error] ?? error}</div> : null}

      <div className="card" style={{ marginTop: 16 }}>
        {accountRows.length === 0 ? (
          <div style={{ color: "var(--muted)" }}>No inboxes connected.</div>
        ) : (
          accountRows.map((a) => {
            const lastSync = lastSyncByAccount.get(a.id);
            const pending = pendingByAccount.get(a.id) ?? 0;
            return (
              <div key={a.id} className="msg inbox-account">
                <div className="who">
                  <span>
                    <MailGlyph /> <b>{a.provider === "imessage" || a.provider === "whatsapp" ? (a.displayName ?? kindLabel(a)) : a.email}</b> <span style={{ color: "var(--muted)" }}>{kindLabel(a)}</span>
                  </span>
                </div>
                <div className="meta">
                  <span>{lastSync ? `Synced ${relativeTime(lastSync)}` : "Never synced"}</span>
                  <span>{pending} pending</span>
                  {a.status === "needs_signin" ? <span className="error">needs sign-in</span> : null}
                  {a.status === "disconnected" ? <span style={{ color: "var(--muted)" }}>disconnected</span> : null}
                </div>
                {a.status !== "ok" ? (
                  a.provider === "outlook" || (a.provider === "imap" && withGoogle.has(a.id) && !withPassword.has(a.id)) ? (
                    <div className="row" style={{ marginTop: 8 }}>
                      <a className="btn" href={a.provider === "outlook" ? "/api/oauth/microsoft/start" : "/api/oauth/google/start"}>
                        Reconnect
                      </a>
                      <DisconnectButton accountId={a.id} email={a.email} />
                    </div>
                  ) : (
                    <>
                      <AddInbox
                        microsoftReady={microsoftReady}
                        triggerLabel="Reconnect"
                        initial={{
                          address: a.email,
                          step: a.kind === "gmail" ? "gmail" : "generic",
                          settings: {
                            imapHost: a.imapHost ?? "",
                            imapPort: a.imapPort ?? 993,
                            smtpHost: a.smtpHost ?? "",
                            smtpPort: a.smtpPort ?? 465,
                            kind: a.kind ?? "generic",
                          },
                        }}
                      />
                      <div className="row" style={{ marginTop: 8 }}>
                        <DisconnectButton accountId={a.id} email={a.email} />
                      </div>
                    </>
                  )
                ) : (
                  <div className="row" style={{ marginTop: 8 }}>
                    <DisconnectButton accountId={a.id} email={a.email} />
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="who">
          <span>
            <b>Models</b>
          </span>
        </div>
        <div className="meta">
          <span>Which model answers for each job. Change one in <code>.env</code> and restart the app.</span>
        </div>
        {MODEL_ROLES.map((role) => (
          <div key={role} className="meta" style={{ marginTop: 6 }}>
            <span style={{ minWidth: 116, display: "inline-block" }}>{ROLE_LABELS[role]}</span>
            <span style={{ color: "var(--fg)" }}>
              {formatModelRef(cfg.models[role])}
              {role === "sorter_backlog" && backlogSorterIsTrickle() ? " (same as sorting)" : ""}
            </span>
            <span>
              <code>{MODEL_ENV_VARS[role]}</code>
            </span>
          </div>
        ))}
        <div className="meta" style={{ marginTop: 10 }}>
          <Link href="/usage">See usage →</Link>
        </div>
      </div>

      <AlsoYou addresses={aliasesForForm()} />

      <Nav counts={treeCounts(selectedId, treeScope(resolveForTree(db, selectedId, await viewSelection(db, selectedId))))} />
    </main>
  );
}
