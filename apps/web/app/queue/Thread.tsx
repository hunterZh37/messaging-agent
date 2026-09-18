"use client";

import { useLayoutEffect, useRef, useState } from "react";

/** How many of a chat's texts show at once; the rest wait behind "Show earlier". */
const CHAT_PAGE = 120;
import type { AttachmentRow, MessageRow } from "@messaging-agent/core";
import { splitQuoted, stripHtml } from "@messaging-agent/core/text";
import { formatSize, isPreviewable } from "@/lib/attachments";
import { fileKind } from "@/lib/attachments";
import { formatTime, initials, recipientsLine } from "@/lib/format";
import { linkSegments } from "@/lib/linkify";
import { AttachmentPreview, ClipIcon } from "./AttachmentPreview";

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4v11" />
      <path d="M8 12l4 4 4-4" />
      <path d="M5 19h14" />
    </svg>
  );
}

/**
 * Plain text with its links clickable and their URLs out of sight: the label
 * a sender put before a URL becomes the link, a bare URL shows as its host.
 * Shared with the send preview, so a reply reads there the way it will read
 * in the recipient's mailbox.
 */
export function PlainBody({ text }: { text: string }) {
  return (
    <>
      {linkSegments(text.replace(/\n[ \t]*(\n[ \t]*){2,}/g, "\n\n")).map((s, i) =>
        s.kind === "link" ? (
          <a key={i} href={s.href} target="_blank" rel="noopener noreferrer">
            {s.text}
          </a>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

function attachmentHref(id: string, download: boolean): string {
  return `/api/attachments/${encodeURIComponent(id)}${download ? "?download=1" : ""}`;
}

/**
 * The thread as a conversation, oldest first: the operator's messages sit on
 * the right, everyone else's on the left, each in its own bubble under a
 * small who-line (avatar, name, address, recipients, date). Shared by the
 * draft card and the Thread view. `attachments` is optional: the queue's
 * draft card renders threads without chips.
 */
export function Thread({
  messages,
  attachments,
  chat = false,
}: {
  messages: MessageRow[];
  /** Kept for callers; every message is shown in the chat layout. */
  initialExpandedId?: string;
  attachments?: Record<string, AttachmentRow[]>;
  /** A chat: one person, one handle, so the bubbles carry a name and a time and nothing else. */
  chat?: boolean;
}) {
  const [showPlain, setShowPlain] = useState<Set<string>>(new Set());
  const [showQuoted, setShowQuoted] = useState<Set<string>>(new Set());

  const [previewing, setPreviewing] = useState<Set<string>>(new Set());
  // A chat with its whole history is thousands of bubbles (stress loop,
  // 2026-09-11: 6,354 for one person). The newest page shows; each press
  // of "Show earlier" reveals another page above it.
  const [shown, setShown] = useState(CHAT_PAGE);
  const visible = chat && messages.length > shown ? messages.slice(messages.length - shown) : messages;
  const hidden = messages.length - visible.length;
  // Revealing a page above the newest texts must not move what the eye is on
  // (stress loop, 2026-09-11: the view jumped by the height of the new page):
  // the scroller's height before the reveal is kept, and the difference is
  // added to its scroll position once the page is in.
  const root = useRef<HTMLDivElement>(null);
  const kept = useRef<{ scroller: HTMLElement; height: number } | null>(null);
  function reveal() {
    // The nearest ancestor that actually scrolls: the pane on desktop, the
    // page itself on a phone, where the pane is only a box.
    let scroller: HTMLElement | null = root.current?.parentElement ?? null;
    while (scroller && !(/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) scroller = scroller.parentElement;
    scroller ??= document.scrollingElement as HTMLElement | null;
    if (scroller) kept.current = { scroller, height: scroller.scrollHeight };
    setShown((n) => n + CHAT_PAGE);
  }
  useLayoutEffect(() => {
    const k = kept.current;
    if (!k) return;
    kept.current = null;
    k.scroller.scrollTop += k.scroller.scrollHeight - k.height;
  }, [shown]);

  function toggle(set: Set<string>, id: string, apply: (next: Set<string>) => void): void {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    apply(next);
  }

  return (
    <div className="thread" ref={root}>
      {hidden > 0 ? (
        <button type="button" className="btn quiet thread-earlier" onClick={reveal}>
          {`Show earlier · ${hidden.toLocaleString()} more`}
        </button>
      ) : null}
      {visible.map((m) => {
        const me = m.isFromOperator;
        const who = me ? "You" : (m.fromName ?? m.fromAddress);
        const plain = showPlain.has(m.id);
        // Every reply carries the messages it answers, so a six-message
        // thread renders its first message six times and the panel grows with
        // the square of the conversation. A reply is shown as the words its
        // sender typed, which is what makes the panel read as a chat; the
        // original, history and formatting and all, is one click away.
        const { own, quoted } = splitQuoted(m.bodyText);
        // The two parts of a mail can disagree: some senders quote the history
        // in the HTML and not in the text, so both are asked.
        const quotedInHtml = m.bodyHtml ? splitQuoted(stripHtml(m.bodyHtml)).quoted.length > 0 : false;
        // A message that is nothing but history — a bare forward — has no own
        // words to show, so it is left whole.
        const hasQuoted = own.length > 0 && (quoted.length > 0 || quotedInHtml);
        const quotedOpen = showQuoted.has(m.id);
        const folded = hasQuoted && !quotedOpen;
        const html = Boolean(m.bodyHtml) && !plain && !folded;
        const atts = attachments?.[m.id] ?? [];
        const previews = atts.filter((a) => previewing.has(a.id));
        return (
          <div key={m.id} className={`bubble-row ${me ? "me" : "them"}`}>
            {!me && (
              <span className="avatar" aria-hidden="true">
                {initials(who, m.fromAddress)}
              </span>
            )}
            <div className="bubble-col">
              <div className="bubble-who">
                <b>{who}</b>
                {!me && m.fromName && !chat ? <span className="msg-addr">{m.fromAddress}</span> : null}
                {chat ? null : <span className="msg-to">to {recipientsLine(m.toAddresses, m.ccAddresses)}</span>}
                <time>{formatTime(m.sentAt)}</time>
                {m.bodyHtml && !folded && (
                  <button type="button" className="toggle-format" onClick={() => toggle(showPlain, m.id, setShowPlain)}>
                    {plain ? "Formatted" : "Plain text"}
                  </button>
                )}
              </div>
              <div className="bubble">
                {atts.length > 0 && (
                  <div className="att-row">
                    {atts.map((a) => {
                      const shown = previewing.has(a.id);
                      const label = (
                        <>
                          <span className="att-kind">{fileKind(a.filename)}</span>
                          <span className="att-name">{a.filename}</span>
                          <span className="att-size">{formatSize(a.size)}</span>
                        </>
                      );
                      return (
                        <span key={a.id} className={`chip att-chip${shown ? " on" : ""}`}>
                          {isPreviewable(a.mimeType) ? (
                            <button
                              type="button"
                              className="att-open"
                              onClick={() => toggle(previewing, a.id, setPreviewing)}
                              aria-expanded={shown}
                            >
                              {label}
                            </button>
                          ) : (
                            // Nothing else previews safely, so the chip itself downloads.
                            <a className="att-open" href={attachmentHref(a.id, true)} download={a.filename}>
                              {label}
                            </a>
                          )}
                          <a className="att-dl" href={attachmentHref(a.id, true)} download={a.filename} aria-label={`Download ${a.filename}`}>
                            <DownloadIcon />
                          </a>
                        </span>
                      );
                    })}
                  </div>
                )}
                {previews.map((a) => (
                  <AttachmentPreview key={a.id} href={attachmentHref(a.id, false)} filename={a.filename} mimeType={a.mimeType} />
                ))}
                {html ? (
                  <div className="msg-html" dangerouslySetInnerHTML={{ __html: m.bodyHtml ?? "" }} />
                ) : (
                  <div className="body">
                    <PlainBody text={folded ? own : m.bodyText} />
                  </div>
                )}
                {hasQuoted ? (
                  <button type="button" className="quoted-toggle" aria-expanded={quotedOpen} onClick={() => toggle(showQuoted, m.id, setShowQuoted)}>
                    {quotedOpen ? "Hide quoted history" : "Show quoted history"}
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
