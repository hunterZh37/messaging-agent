"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { sendsOnEnter } from "@/lib/chat";
import { sendTextAction } from "../actions";

function ArrowUpIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 19V5" />
      <path d="M5 12l7-7 7 7" />
    </svg>
  );
}

/**
 * The place to type a text into a chat (operator, 2026-09-11: "a place where I
 * can type out a message versus just those buttons"). The Ask panel's pill:
 * one line that grows, an arrow to send, Enter sends and Shift+Enter breaks
 * the line. A text goes at once, with no six seconds, and the bubble is the
 * page's to show once the server has read it back.
 *
 * Opening a chat lands here (operator, 2026-09-11: "scroll me all the way to
 * where the input box is"); `StickToBottom` does the landing since
 * 2026-09-14, holding the pane at its bottom while photos load in.
 */
export function TextComposer({ threadId, name }: { threadId: string; name: string }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const box = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const router = useRouter();

  function send() {
    const body = text.trim();
    if (body === "" || pending) return;
    setError(null);
    startTransition(async () => {
      const r = await sendTextAction(threadId, body);
      if (r && "error" in r) return setError(r.error);
      setText("");
      if (box.current) box.current.style.height = "40px";
      router.refresh();
      // The new bubble arrives under the box; the box stays where the eye is.
      window.setTimeout(() => root.current?.scrollIntoView({ block: "end" }), 300);
    });
  }

  return (
    <div className="text-composer" ref={root}>
      <div className="text-composer-row">
        <textarea
          ref={box}
          className="field ask-input"
          rows={1}
          value={text}
          placeholder={`Text ${name}…`}
          disabled={pending}
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
          }}
          onKeyDown={(e) => {
            if (!sendsOnEnter(e)) return;
            e.preventDefault();
            send();
          }}
        />
        <button type="button" className="ask-send" onClick={send} disabled={pending || text.trim() === ""} aria-label={pending ? "Sending…" : "Send"} title={pending ? "Sending…" : "Send (Enter)"}>
          <ArrowUpIcon />
        </button>
      </div>
      {error ? <div className="error">{error}</div> : null}
    </div>
  );
}
