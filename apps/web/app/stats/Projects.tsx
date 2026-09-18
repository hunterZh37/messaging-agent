import type { ProjectStats } from "@messaging-agent/core";

function count(n: number): string {
  return n.toLocaleString();
}

function ago(at: number | null): string {
  if (at === null) return "—";
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days <= 0) return "today";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

/**
 * An inbox in two parts. The name alone will not do: this operator has the
 * same local part at four different providers, and stripping the domain left
 * four rows all reading "hunter" and no way to tell which was which.
 */
function inboxParts(email: string): { name: string; where: string } {
  const at = email.indexOf("@");
  if (at === -1) return { name: email, where: "" };
  return { name: email.slice(0, at), where: email.slice(at + 1) };
}

/**
 * Projects, per inbox and one by one (operator, 2026-09-17).
 *
 * A project belongs to one inbox, so "how many projects" is a question about
 * an inbox, and an inbox with none is the row worth looking at: everything
 * arriving there is landing unsorted.
 *
 * Filed and unfiled are shown; what the filing pass has not reached yet is a
 * quiet footnote rather than a column. It is mostly chat history nobody was
 * ever going to file, and putting it in the table made a working set of
 * projects look like a failure.
 */
export function Projects({ stats }: { stats: ProjectStats }) {
  const { byInbox, projects, totals } = stats;
  if (byInbox.length === 0) return null;

  const considered = totals.filed + totals.unfiled;
  const busiest = projects[0]?.messages ?? 0;

  return (
    <section className="stat-card wide">
      <h2>Projects</h2>
      <p className="stat-note">
        You describe a project in a sentence and messages are filed under the one they match. Each project belongs to a
        single inbox.
      </p>

      <div className="habit-grid">
        <div className="habit">
          <b>{count(totals.projects)}</b>
          <span>projects</span>
          <span className="meta">across {byInbox.filter((i) => i.projects > 0).length} inboxes</span>
        </div>
        <div className="habit">
          <b>{count(totals.filed)}</b>
          <span>messages filed</span>
          <span className="meta">{considered > 0 ? `${Math.round((totals.filed / considered) * 100)}% of those looked at` : "none yet"}</span>
        </div>
        <div className="habit">
          <b>{count(totals.unfiled)}</b>
          <span>looked at and filed nowhere</span>
          <span className="meta">no project matched them</span>
        </div>
      </div>

      <h3 className="tone-h3 spaced">By inbox</h3>
      <table className="stat-table">
        <thead>
          <tr>
            <th>Inbox</th>
            <th className="num">Projects</th>
            <th className="num">Filed</th>
            <th className="num">Nowhere</th>
            <th>How much lands somewhere</th>
          </tr>
        </thead>
        <tbody>
          {byInbox.map((i) => {
            const seen = i.filed + i.unfiled;
            const share = seen > 0 ? (i.filed / seen) * 100 : 0;
            return (
              <tr key={i.accountId}>
                <td>
                  <span className="who">{inboxParts(i.email).name}</span>
                  <span className="who-sub">
                    {inboxParts(i.email).where || i.provider}
                  </span>
                </td>
                <td className="num">{i.projects === 0 ? <span className="never">none</span> : count(i.projects)}</td>
                <td className="num">{count(i.filed)}</td>
                <td className="num">{count(i.unfiled)}</td>
                <td>
                  {seen === 0 ? (
                    <span className="never">nothing sorted yet</span>
                  ) : (
                    <span className="fill">
                      <span className="fill-track">
                        <span className="fill-done" style={{ width: `${share}%` }} />
                      </span>
                      <span className="fill-num">{Math.round(share)}%</span>
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h3 className="tone-h3 spaced">Every project</h3>
      <table className="stat-table">
        <thead>
          <tr>
            <th>Project</th>
            <th>Inbox</th>
            <th className="num">Messages</th>
            <th className="num">By hand</th>
            <th className="num">Last one</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.id}>
              <td>
                <span className="who">{p.name}</span>
                {p.groupName ? <span className="who-sub">{p.groupName}</span> : null}
              </td>
              <td>
                <span className="where-group" title={p.email}>
                  {inboxParts(p.email).name}
                  <span className="at">@{inboxParts(p.email).where}</span>
                </span>
              </td>
              <td className="num">
                <span className="mini-bar" style={{ width: busiest > 0 ? `${(p.messages / busiest) * 100}%` : "0%" }} />
                {p.messages === 0 ? <span className="never">empty</span> : count(p.messages)}
              </td>
              <td className="num">
                {p.messages === 0 ? "—" : `${Math.round((p.byHand / p.messages) * 100)}%`}
              </td>
              <td className="num">{ago(p.lastAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="caption stat-foot">
        A further {count(totals.pending)} messages have not been through the filing pass at all, mostly chat history
        going back years. That is a backlog, not a verdict on the projects.
      </p>
    </section>
  );
}
