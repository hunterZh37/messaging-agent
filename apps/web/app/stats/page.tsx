import { psychRead, readings, unreadMonths, type Bucket, type Correspondent, type MessagingStats, type Relationship } from "@messaging-agent/core";
import { Tone } from "./Tone";
import { RangeChips } from "./RangeChips";
import { Psych } from "./Psych";
import { Projects } from "./Projects";
import { mailboxStamp, projectsFor, relationshipsFor, statsFor, warmStats } from "@/lib/statsCache";
import { RANGES, rangeKeyFrom, type RangeKey } from "@/lib/statsRanges";
import { core } from "@/lib/core";
import { Nav } from "../queue/Sidebar";
import { treeCounts } from "../queue/counts";
import { inboxSwitcher } from "../queue/switcher";
import { ThemeToggle } from "../queue/ThemeToggle";

export const dynamic = "force-dynamic";

/**
 * The stats page (operator, 2026-09-17: "a stats dashboard that analyses and
 * shows my messaging behaviour"). A mirror rather than a to-do list: it says
 * when you write, how much, to whom and how quickly, and asks nothing of you.
 *
 * It has its own range instead of following the header's period chip, because
 * a pattern needs years to be visible and the chip defaults to Today, which
 * would open this page empty every time.
 */


const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function count(n: number): string {
  return n.toLocaleString();
}

/** A share, said as a whole number: the decimals are false precision here. */
function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";
}

/** A wait in minutes, said the way a person would say it. */
function waitLabel(minutes: number | null): string {
  if (minutes === null) return "—";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 60 * 36) return `${(minutes / 60).toFixed(1)} hours`;
  return `${(minutes / 1440).toFixed(1)} days`;
}

/**
 * A handle as a person would write it. WhatsApp keys people by a bare number
 * and an `@s.whatsapp.net` suffix, which is unreadable in a table and told the
 * operator nothing (2026-09-17). A `@lid` handle carries no number at all, so
 * it says so rather than showing the identifier.
 */
function handleLabel(address: string): string {
  if (address.endsWith("@lid")) return "Someone without a number";
  const digits = address.split("@")[0]?.replace(/\D/g, "") ?? "";
  if (!address.includes("@s.whatsapp.net") && !/^\+?\d{7,15}$/.test(address)) return address;
  if (digits.length === 11 && digits.startsWith("1")) return `+1 ${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `+1 ${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return digits ? `+${digits}` : address;
}

function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1]} ${y?.slice(2)}`;
}

/** Bars of two parts: what the operator sent, and what arrived. */
function Bars({ rows, label, peak }: { rows: { key: string; sent: number; received: number; title: string }[]; label: string; peak: number }) {
  return (
    <section className="stat-card">
      <h2>{label}</h2>
      <div className="bars" role="img" aria-label={label}>
        {rows.map((r) => {
          const total = r.sent + r.received;
          return (
            <div className="bar-col" key={r.key} title={`${r.title}: ${count(r.sent)} sent, ${count(r.received)} received`}>
              <div className="bar" style={{ height: peak > 0 ? `${Math.max(2, (total / peak) * 100)}%` : "2%" }}>
                <span className="bar-recv" style={{ height: total > 0 ? `${(r.received / total) * 100}%` : "0%" }} />
              </div>
              <span className="bar-key">{r.title}</span>
            </div>
          );
        })}
      </div>
      <p className="stat-legend">
        <span className="key-sent" /> yours <span className="key-recv" /> theirs
      </p>
    </section>
  );
}

function hourRows(byHour: Bucket[]) {
  return Array.from({ length: 24 }, (_, h) => {
    const key = String(h).padStart(2, "0");
    const b = byHour.find((x) => x.key === key);
    return { key, sent: b?.sent ?? 0, received: b?.received ?? 0, title: h % 6 === 0 ? `${h}` : "" };
  });
}

function weekdayRows(byWeekday: Bucket[]) {
  return WEEKDAYS.map((name, i) => {
    const b = byWeekday.find((x) => x.key === String(i));
    return { key: String(i), sent: b?.sent ?? 0, received: b?.received ?? 0, title: name };
  });
}

/** The months, thinned so the labels do not collide once there are years of them. */
function monthRows(byMonth: Bucket[]) {
  const every = byMonth.length > 40 ? 12 : byMonth.length > 18 ? 6 : 3;
  return byMonth.map((b, i) => ({
    key: b.key,
    sent: b.sent,
    received: b.received,
    title: i % every === 0 ? monthLabel(b.key) : "",
  }));
}

/** "4m", "2h", "3d" — a wait people read at a glance rather than divide. */
function wait(minutes: number | null): string {
  if (minutes === null) return "—";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (60 * 24))}d`;
}

function ago(at: number | null): string {
  if (at === null) return "—";
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

/**
 * Who out-waits whom. The bar leans towards whichever side answers slower,
 * so an even relationship sits in the middle and a lopsided one is visible
 * without reading either number.
 */
function Lean({ you, them }: { you: number | null; them: number | null }) {
  if (you === null || them === null) return <span className="lean-none">—</span>;
  // The mark sits over whoever is slower, so it must be their share of the
  // combined wait: a big `you` pulls it left, onto the operator's own side.
  const share = you + them === 0 ? 0.5 : them / (you + them);
  return (
    <span className="lean">
      <span className="lean-side">{wait(you)}</span>
      <span className="lean-track">
        <span className="lean-mark" style={{ left: `${Math.min(96, Math.max(4, share * 100))}%` }} />
      </span>
      <span className="lean-side them">{wait(them)}</span>
    </span>
  );
}

/**
 * The shape of each relationship rather than its volume: how long each side
 * leaves the other, how much each writes, and whether it is growing quieter.
 *
 * Deliberately all counts. Naming somebody and guessing at their state of
 * mind is not something this page does, so nothing here reads as a verdict
 * on the person, only on the traffic between them and the operator.
 */
function Between({ rows }: { rows: Relationship[] }) {
  return (
    <section className="stat-card wide">
      <h2>How each one goes</h2>
      <p className="stat-note">Who waits longer, who writes more, and which ones are going quiet.</p>
      <table className="stat-table">
        <thead>
          <tr>
            <th>Who</th>
            <th className="lean-head">You wait <span>·</span> they wait</th>
            <th className="num">Words you / them</th>
            <th className="num">Last heard</th>
            <th>vs 90 days before</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const change = r.prior === 0 ? null : Math.round(((r.recent - r.prior) / r.prior) * 100);
            return (
              <tr key={r.address}>
                <td>
                  <span className="who">{r.name || handleLabel(r.address)}</span>
                  {r.groupName ? <span className="who-sub">in {r.groupName}</span> : null}
                </td>
                <td>
                  <Lean you={r.yourReplyMinutes} them={r.theirReplyMinutes} />
                </td>
                <td className="num">
                  {r.medianWordsYou ?? "—"} / {r.medianWordsThem ?? "—"}
                </td>
                <td className="num">{ago(r.lastHeardAt)}</td>
                <td>
                  {change === null ? (
                    <span className="trend-new">new</span>
                  ) : (
                    <span className={change < -25 ? "trend-down" : change > 25 ? "trend-up" : "trend-flat"}>
                      {change > 0 ? "+" : ""}
                      {change}%
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function People({ rows }: { rows: Correspondent[] }) {
  const most = rows[0]?.received ?? 0;
  return (
    <section className="stat-card wide">
      <h2>Who you hear from</h2>
      <table className="stat-table">
        <thead>
          <tr>
            <th>Who</th>
            <th className="num">Messages</th>
            <th className="num">Threads</th>
            <th>Where</th>
            <th>You answered</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.address}>
              <td>
                <span className="who">{r.name || handleLabel(r.address)}</span>
                {r.name ? <span className="who-sub">{handleLabel(r.address)}</span> : null}
              </td>
              <td className="num">
                <span className="mini-bar" style={{ width: most > 0 ? `${(r.received / most) * 100}%` : "0%" }} />
                {count(r.received)}
              </td>
              <td className="num">{count(r.threads)}</td>
              <td>
                {r.groupName ? <span className="where-group">in {r.groupName}</span> : <span className="where-direct">direct</span>}
              </td>
              <td>
                {r.repliedThreads === 0 ? (
                  <span className="never">{r.groupName ? "you never post" : "never"}</span>
                ) : (
                  `${Math.round((r.repliedThreads / Math.max(1, r.threads)) * 100)}% of threads`
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="stat-note">
        Counted by what arrived. Most of the loudest names here are talking in a group you are in rather than writing to
        you, which is what the Where column says; and a newsletter can sit beside a friend, which is what the last one
        settles.
      </p>
    </section>
  );
}

export default async function StatsPage({ searchParams }: { searchParams: Promise<{ range?: string; account?: string }> }) {
  const { range, account } = await searchParams;
  const { db } = core();
  // The tree still needs its counts, but this page is every inbox at once by
  // choice, so it shows no inbox chip: one would promise a filter it does not
  // apply (2026-09-17).
  const { selectedId } = await inboxSwitcher(account);
  const key: RangeKey = rangeKeyFrom(range);
  // Held until a message arrives or leaves, so flipping between the ranges
  // does not pay for the same second and a half of scanning again.
  const stamp = mailboxStamp();
  const stats: MessagingStats = statsFor(key, stamp);
  // Whatever the mailbox has done since the last warm-up, settle the other
  // three ranges while this one is being read. A range already held costs
  // nothing, so this is a no-op on a quiet server.
  void warmStats();

  const { totals } = stats;
  const span =
    totals.firstAt && totals.lastAt
      ? `${new Date(totals.firstAt).toLocaleDateString(undefined, { month: "short", year: "numeric" })} to ${new Date(totals.lastAt).toLocaleDateString(undefined, { month: "short", year: "numeric" })}`
      : "nothing yet";
  const chats = stats.bySource.find((s) => s.source === "chats");
  const mail = stats.bySource.find((s) => s.source === "mail");
  const chatTotal = (chats?.sent ?? 0) + (chats?.received ?? 0);
  const mailTotal = (mail?.sent ?? 0) + (mail?.received ?? 0);

  const hours = hourRows(stats.byHour);
  const days = weekdayRows(stats.byWeekday);
  const months = monthRows(stats.byMonth);
  const peak = (rows: { sent: number; received: number }[]) => Math.max(1, ...rows.map((r) => r.sent + r.received));
  const busiest = [...hours].sort((a, b) => b.sent - a.sent)[0];
  const h = stats.habits;

  return (
    <div className="shell">
      <Nav counts={treeCounts(selectedId)} />
      <main className="stats-page">
        <div className="head-row first">
          <span className="head-title">Stats</span>
          <span className="head-sub">how you message</span>
          <span className="head-spacer" />
          <div className="range-row">
            <RangeChips ranges={RANGES.map((r) => ({ key: r.key, label: r.label }))} active={key} />
          </div>
          <ThemeToggle />
        </div>

        {totals.messages === 0 ? (
          <p className="meta stat-empty">Nothing in this range yet.</p>
        ) : (
          <>
            <section className="stat-figures">
              <div>
                <b>{count(totals.messages)}</b>
                <span>messages, {span}</span>
              </div>
              <div>
                <b>{count(totals.sent)}</b>
                <span>you wrote, {Math.round((totals.sent / totals.messages) * 100)}% of it</span>
              </div>
              <div>
                <b>{count(totals.people)}</b>
                <span>people wrote to you</span>
              </div>
              <div>
                <b>{count(totals.threads)}</b>
                <span>conversations</span>
              </div>
            </section>

            <section className="stat-card">
              <h2>How fast you answer</h2>
              <div className="reply-grid">
                {stats.replyTimes.map((r) => (
                  <div key={r.source} className="reply-cell">
                    <span className="reply-src">{r.source === "mail" ? "Mail" : "Chats"}</span>
                    <b>{waitLabel(r.medianMinutes)}</b>
                    <span className="meta">
                      typically · three in four inside {waitLabel(r.p75Minutes)} · {count(r.replied)} answered
                    </span>
                  </div>
                ))}
              </div>
              <p className="stat-note">
                The middle wait, not the average: one holiday would own an average. Messages you never answered are not
                counted here — they are silences, not long waits.
              </p>
            </section>

            <section className="stat-card">
              <h2>How you conduct yourself</h2>
              <div className="habit-grid">
                <div className="habit">
                  <b>{pct(h.startedByYou, h.startedByYou + h.startedByThem)}</b>
                  <span>of conversations you opened</span>
                  <span className="meta">{count(h.startedByYou)} of {count(h.startedByYou + h.startedByThem)}</span>
                </div>
                <div className="habit">
                  <b>{pct(h.lastWordYours, h.threadsTotal)}</b>
                  <span>you had the last word in</span>
                  <span className="meta">{count(h.lastWordYours)} of {count(h.threadsTotal)}</span>
                </div>
                <div className="habit">
                  <b>
                    {h.medianWordsYou ?? "—"} <span className="vs">vs {h.medianWordsThem ?? "—"}</span>
                  </b>
                  <span>words in a typical message</span>
                  <span className="meta">yours, then theirs</span>
                </div>
                <div className="habit">
                  <b>{pct(h.doubleTexts, totals.sent)}</b>
                  <span>of your messages follow your own</span>
                  <span className="meta">{count(h.doubleTexts)} sent back to back</span>
                </div>
                <div className="habit">
                  <b>{count(h.questionsAsked)}</b>
                  <span>of your messages ask something</span>
                  <span className="meta">{pct(h.questionsAsked, totals.sent)} of them</span>
                </div>
                <div className="habit">
                  <b>{count(h.lateNight)}</b>
                  <span>sent between midnight and 5am</span>
                  <span className="meta">{pct(h.lateNight, totals.sent)} of them</span>
                </div>
              </div>
              <p className="stat-note">
                Counts, not conclusions. Each of these can be checked against the database; none of them says what kind
                of person it makes anyone. Messages sent back to back are usually one thought arriving in three parts.
              </p>
            </section>

            <Bars
              rows={hours}
              label={`Your day${busiest && busiest.sent > 0 ? ` — you write most at ${Number(busiest.key)}:00` : ""}`}
              peak={peak(hours)}
            />
            <Bars rows={days} label="Your week" peak={peak(days)} />
            <Bars rows={months} label="Over the years" peak={peak(months)} />

            <section className="stat-card">
              <h2>Mail and chats</h2>
              <div className="split">
                <div className="split-bar">
                  <span className="split-chats" style={{ width: `${(chatTotal / Math.max(1, chatTotal + mailTotal)) * 100}%` }} />
                </div>
                <div className="split-keys">
                  <span>
                    <b>{count(chatTotal)}</b> chats
                  </span>
                  <span>
                    <b>{count(mailTotal)}</b> mail
                  </span>
                </div>
              </div>
              <p className="stat-note">
                Every other number on this page counts both together, so it mostly describes whichever of these is
                larger.
              </p>
            </section>

            <People rows={stats.topCorrespondents} />
            <Between rows={relationshipsFor(key, stamp)} />
            <Projects stats={projectsFor(key, stamp)} />
            <Tone rows={readings(db)} unread={unreadMonths(db).length} />
            <Psych read={psychRead(db)} />
          </>
        )}
      </main>
    </div>
  );
}
