import Link from "next/link";
import { usageByConversation, usageSummary, USAGE_ROLES, USAGE_ROLE_LABELS, type UsageByRole } from "@messaging-agent/core";
import { core } from "@/lib/core";
import { conversationAboutLabel, conversationCostLabel, conversationTokensLabel } from "@/lib/chat";
import { WINDOWS, type WindowKey } from "@/lib/selection";
import { Nav } from "../queue/Sidebar";
import { treeCounts } from "../queue/counts";
import { resolveForTree, treeScope, viewSelection } from "../inbox/selection";
import { inboxSwitcher } from "../queue/switcher";
import { ThemeToggle } from "../queue/ThemeToggle";
import { barHeight, barWindow, dayKeyOf, fillDays, formatCount, formatDay, formatUsd, formatUsdFine, usageSince, usageWindow } from "./format";

export const dynamic = "force-dynamic";

const WINDOW_LABELS: Record<WindowKey, string> = { today: "Today", "7d": "7 days", "30d": "30 days", all: "All" };

/** Conversations the table lists before it stops and counts the rest. */
const CHAT_ROWS = 20;

/** Roles in the order the operator meets them, and anything the ledger holds that this list does not know. */
function orderRoles(rows: UsageByRole[]): UsageByRole[] {
  const known = USAGE_ROLES.map((role) => rows.find((r) => r.role === role)).filter((r): r is UsageByRole => Boolean(r));
  const rest = rows.filter((r) => !(USAGE_ROLES as readonly string[]).includes(r.role));
  return [...known, ...rest];
}

export default async function UsagePage({ searchParams }: { searchParams: Promise<{ since?: string; account?: string }> }) {
  const { since: sinceParam, account } = await searchParams;
  const { db } = core();
  const { selectedId, switcher } = await inboxSwitcher(account);

  const window = usageWindow(sinceParam);
  const now = Date.now();
  const since = usageSince(window, now);
  // The app runs on the operator's own Mac, so the server's clock is their
  // clock: days are grouped the way they lived them. Nothing here is
  // formatted from a Date after mount, so nothing can shift under hydration.
  const tzOffsetMinutes = new Date().getTimezoneOffset();
  const usageWindowOpts = { ...(since === null ? {} : { since }), tzOffsetMinutes };
  const summary = usageSummary(db, usageWindowOpts);
  const conversations = usageByConversation(db, since === null ? {} : { since });
  const shownChats = conversations.slice(0, CHAT_ROWS);
  const someEstimated = shownChats.some((c) => c.estimated);

  const { totals, byModel, byDay } = summary;
  const localOnly = totals.calls > 0 && byModel.every((m) => m.provider === "ollama");
  const firstDay = byDay[0]?.day;
  const today = dayKeyOf(now, tzOffsetMinutes);
  const from = since === null ? (firstDay ?? today) : dayKeyOf(since, tzOffsetMinutes);
  const { bars, earlier } = barWindow(fillDays(byDay, from < today ? from : today, today));
  const busiest = Math.max(0, ...bars.map((d) => d.costUsd));
  const busiestCalls = Math.max(0, ...bars.map((d) => d.calls));

  return (
    <main>
      <div className="page-header-row">
        <h1>Usage</h1>
        <ThemeToggle className="btn quiet icon-only theme-toggle-mobile" />
      </div>

      <div className="row">
        {WINDOWS.map((w) => (
          <Link key={w} href={`/usage?since=${w}`} className={`chip${w === window ? " on" : ""}`} aria-current={w === window ? "true" : undefined}>
            {WINDOW_LABELS[w]}
          </Link>
        ))}
      </div>

      <div className="usage-tiles">
        <div className="usage-tile">
          <div className="tile-label">Cost</div>
          <div className="tile-value">{formatUsd(totals.costUsd)}</div>
          {localOnly ? <div className="tile-note">local only</div> : null}
          {totals.unpricedCalls > 0 ? <div className="tile-note">{formatCount(totals.unpricedCalls)} on a model with no price</div> : null}
        </div>
        <div className="usage-tile">
          <div className="tile-label">Calls</div>
          <div className="tile-value">{formatCount(totals.calls)}</div>
        </div>
        <div className="usage-tile">
          <div className="tile-label">Input tokens</div>
          <div className="tile-value">{formatCount(totals.inputTokens)}</div>
          {totals.cacheReadTokens > 0 ? <div className="tile-note">{formatCount(totals.cacheReadTokens)} cache read</div> : null}
          {totals.cacheWriteTokens > 0 ? <div className="tile-note">{formatCount(totals.cacheWriteTokens)} cache write</div> : null}
        </div>
        <div className="usage-tile">
          <div className="tile-label">Output tokens</div>
          <div className="tile-value">{formatCount(totals.outputTokens)}</div>
        </div>
      </div>

      {totals.calls === 0 ? (
        <div className="card" style={{ marginTop: 16, color: "var(--muted)" }}>
          No model calls in this window. Sort some mail, or ask Celeste something, and they land here.
        </div>
      ) : null}

      {byModel.length > 0 ? (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="who">
            <span>
              <b>By model</b>
            </span>
          </div>
          {/* A table's columns do not shrink to a phone's width, so the table
              scrolls sideways inside its own card instead of widening the
              page (spec 10a, 2026-09-11). */}
          <div className="usage-table-wrap">
          <table className="usage-table" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Calls</th>
                <th scope="col">Input</th>
                <th scope="col">Output</th>
                <th scope="col">Cost</th>
              </tr>
            </thead>
            <tbody>
              {byModel.map((m) => (
                <tr key={m.ref}>
                  <td>
                    {m.ref}
                    {m.provider === "ollama" ? <span className="usage-tag">local</span> : null}
                  </td>
                  <td>{formatCount(m.calls)}</td>
                  <td>{formatCount(m.inputTokens)}</td>
                  <td>{formatCount(m.outputTokens)}</td>
                  <td>{m.provider === "ollama" ? "$0" : m.unpricedCalls === m.calls ? "unknown" : formatUsdFine(m.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      ) : null}

      {summary.byRole.length > 0 ? (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="who">
            <span>
              <b>By job</b>
            </span>
          </div>
          {/* A table's columns do not shrink to a phone's width, so the table
              scrolls sideways inside its own card instead of widening the
              page (spec 10a, 2026-09-11). */}
          <div className="usage-table-wrap">
          <table className="usage-table" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">Calls</th>
                <th scope="col">Input</th>
                <th scope="col">Output</th>
                <th scope="col">Cost</th>
              </tr>
            </thead>
            <tbody>
              {orderRoles(summary.byRole).map((r) => (
                <tr key={r.role}>
                  <td>{USAGE_ROLE_LABELS[r.role as keyof typeof USAGE_ROLE_LABELS] ?? r.role}</td>
                  <td>{formatCount(r.calls)}</td>
                  <td>{formatCount(r.inputTokens)}</td>
                  <td>{formatCount(r.outputTokens)}</td>
                  <td>{formatUsdFine(r.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      ) : null}

      {shownChats.length > 0 ? (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="who">
            <span>
              <b>By conversation</b>
            </span>
          </div>
          {/* A table's columns do not shrink to a phone's width, so the table
              scrolls sideways inside its own card instead of widening the
              page (spec 10a, 2026-09-11). */}
          <div className="usage-table-wrap">
          <table className="usage-table" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th scope="col">Conversation</th>
                <th scope="col">Turns</th>
                <th scope="col">Tokens</th>
                <th scope="col">Cost</th>
                <th scope="col">Last asked</th>
              </tr>
            </thead>
            <tbody>
              {shownChats.map((c) => (
                <tr key={c.chatId}>
                  <td className="usage-chat-title" title={conversationAboutLabel(c.title, c.firstQuestion, Number.MAX_SAFE_INTEGER)}>
                    {conversationAboutLabel(c.title, c.firstQuestion)}
                    {c.estimated ? <span className="usage-tag">estimated</span> : null}
                  </td>
                  <td>{formatCount(c.turns)}</td>
                  <td>{conversationTokensLabel(c.inputTokens, c.outputTokens)}</td>
                  <td>{conversationCostLabel(c.costUsd)}</td>
                  <td>{c.lastAt === null ? "—" : formatDay(dayKeyOf(c.lastAt, tzOffsetMinutes))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          {conversations.length > shownChats.length ? (
            <div className="usage-note">and {formatCount(conversations.length - shownChats.length)} more</div>
          ) : null}
          {someEstimated ? (
            <div className="usage-note">
              An estimated row is a conversation from before the ledger: its figures come from the tokens each answer recorded, so the prompt
              cache is not in them.
            </div>
          ) : null}
        </div>
      ) : null}

      {bars.length > 0 ? (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="who">
            <span>
              <b>By day</b>
            </span>
          </div>
          <div className="usage-bars">
            {bars.map((d) => (
              <div
                key={d.day}
                className={`usage-bar${d.calls === 0 ? " empty" : ""}`}
                title={`${formatDay(d.day)} · ${formatCount(d.calls)} call(s) · ${formatCount(d.inputTokens)} in, ${formatCount(d.outputTokens)} out · ${formatUsdFine(d.costUsd)}`}
              >
                <div className="bar-fill" style={{ height: `${barHeight(busiest > 0 ? d.costUsd : d.calls, busiest > 0 ? busiest : busiestCalls)}%` }} />
              </div>
            ))}
          </div>
          <div className="usage-days">
            <span>{formatDay(bars[0]!.day)}</span>
            <span>{formatDay(bars[bars.length - 1]!.day)}</span>
          </div>
          {earlier > 0 ? <div className="usage-note">and {formatCount(earlier)} earlier day(s)</div> : null}
        </div>
      ) : null}

      <div className="usage-note">
        Prices are Anthropic list prices; local models cost nothing. Cache reads are billed at 10%, writes at 125%.
      </div>

      <Nav counts={treeCounts(selectedId, treeScope(resolveForTree(db, selectedId, await viewSelection(db, selectedId))))} />
    </main>
  );
}
