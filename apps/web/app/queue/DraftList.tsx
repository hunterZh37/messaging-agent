import Link from "next/link";
import type { DraftView } from "@messaging-agent/core";
import { formatTime, shortAccount } from "@/lib/format";
import { draftHref } from "@/lib/queue";
import { ChannelIcon } from "../inbox/icons";


/** "to ana@x.com" or "to ana@x.com +2": who this draft is addressed to. */
function toLine(to: string[]): string {
  if (to.length === 0) return "to (no recipient)";
  return to.length > 1 ? `to ${to[0]} +${to.length - 1}` : `to ${to[0]}`;
}

/**
 * One pending draft, read the way a mail row is read (spec 10a): the inbox it
 * belongs to and when Celeste wrote it, who it goes to, the subject it
 * answers, and the opening of the draft itself. The tag says whether this is
 * an answer to something inbound or a nudge after the operator's own last
 * message (spec 8), because the two are read differently.
 */
function Row(props: { view: DraftView; selected: boolean; account: string | undefined }) {
  const { view, selected, account } = props;
  const { draft } = view;
  return (
    <Link href={draftHref(draft.id, account)} className={`inbox-row${selected ? " selected" : ""}`}>
      <div className="meta">
        <ChannelIcon provider={view.account.provider} />
        <span>{shortAccount(view.account.email)}</span>
        <span style={{ marginLeft: "auto" }}>{formatTime(draft.createdAt)}</span>
      </div>
      <div className="inbox-sender">
        <span>{toLine(draft.toAddresses)}</span>
        <span className="tag">{draft.mode === "follow-up" ? "follow-up" : draft.mode === "new" ? "compose" : "reply"}</span>
      </div>
      {/* A composed draft has no reply-to; its own subject is what the row shows (spec 2026-09-22). */}
      <div className="inbox-subject">{(view.replyTo ? view.replyTo.subject : view.draft.subject) || "(no subject)"}</div>
      <div className="oneline">{draft.originalText.replace(/\s+/g, " ").slice(0, 140)}</div>
    </Link>
  );
}

/**
 * The left pane of the Drafts page: the queue itself, oldest first, so the
 * operator works down it rather than being handed one card at a time. The
 * order never moves under them — Skip and Send take a draft out and the
 * selection steps to its neighbour, which is what the list is for.
 */
export function DraftList(props: { items: DraftView[]; selectedId: string | null; account: string | undefined }) {
  return (
    <div className="inbox-panel">
      <div className="inbox-rows">
        {props.items.map((view) => (
          <Row
            key={view.draft.id}
            view={view}
            selected={view.draft.id === props.selectedId}
            account={props.account}
          />
        ))}
      </div>
    </div>
  );
}
